require("dotenv").config();
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { Client, GatewayIntentBits, Events, REST, Routes, SlashCommandBuilder } = require("discord.js");
const { Client: SSHClient } = require("ssh2");

const { DISCORD_TOKEN, CLIENT_ID, GUILD_ID } = process.env;
const ADMIN_IDS = new Set((process.env.ADMIN_IDS || "").split(",").map(x => x.trim()).filter(Boolean));
const DATA_DIR = path.resolve(process.env.DATA_DIR || "./data");
const DB_FILE = path.join(DATA_DIR, "servers.json");

if (!DISCORD_TOKEN || !CLIENT_ID || !GUILD_ID || !ADMIN_IDS.size) {
  throw new Error("Missing .env values. Required: DISCORD_TOKEN, CLIENT_ID, GUILD_ID, ADMIN_IDS.");
}

function ensureDb() {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, "[]\n", { mode: 0o600 });
}
function loadServers() {
  ensureDb();
  return JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
}
function saveServers(items) {
  ensureDb();
  fs.writeFileSync(DB_FILE, JSON.stringify(items, null, 2) + "\n", { mode: 0o600 });
}
const isLabel = s => /^[a-zA-Z0-9_-]{1,32}$/.test(s);
const isApp = s => /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/.test(s);
const sh = s => "'" + String(s).replace(/'/g, "'\\''") + "'";
const getServer = name => loadServers().find(x => x.name.toLowerCase() === name.toLowerCase());

function sshRun(server, command, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const conn = new SSHClient();
    let stdout = "", stderr = "", done = false;
    const finish = (err, result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      conn.end();
      err ? reject(err) : resolve(result);
    };
    const timer = setTimeout(() => finish(new Error("SSH command timed out.")), timeoutMs);
    let privateKey;
    try {
      privateKey = fs.readFileSync(server.keyPath);
    } catch (e) {
      return finish(new Error("Cannot read SSH private key from configured path: " + e.message));
    }

    conn.on("ready", () => {
      conn.exec(command, { pty: false }, (err, stream) => {
        if (err) return finish(err);
        stream.on("data", d => { stdout = (stdout + d.toString()).slice(-10000); });
        stream.stderr.on("data", d => { stderr = (stderr + d.toString()).slice(-4000); });
        stream.on("close", code => finish(null, { code, stdout: stdout.trim(), stderr: stderr.trim() }));
      });
    }).on("error", finish);

    conn.connect({
      host: server.host,
      port: server.port || 22,
      username: server.username,
      privateKey,
      readyTimeout: 15000,
      keepaliveInterval: 10000,
      hostHash: "sha256",
      hostVerifier: fingerprint => fingerprint === server.hostFingerprint
    });
  });
}
async function checked(server, command, timeout) {
  const r = await sshRun(server, command, timeout);
  if (r.code !== 0) throw new Error((r.stderr || r.stdout || `Remote command exited with ${r.code}`).slice(0, 1200));
  return r.stdout || "Completed.";
}
async function safeReply(i, content) {
  const payload = { content: String(content).slice(0, 1900), ephemeral: true };
  if (i.deferred || i.replied) return i.editReply(payload);
  return i.reply(payload);
}

const commands = [
  new SlashCommandBuilder()
    .setName("add-vps").setDescription("Register a VPS you own or are authorized to manage")
    .addStringOption(o => o.setName("name").setDescription("VPS label").setRequired(true))
    .addStringOption(o => o.setName("host").setDescription("VPS IP or hostname").setRequired(true))
    .addStringOption(o => o.setName("username").setDescription("SSH user, preferably non-root").setRequired(true))
    .addStringOption(o => o.setName("key_path").setDescription("Absolute path to private SSH key on bot host").setRequired(true))
    .addStringOption(o => o.setName("fingerprint").setDescription("SSH SHA256 host-key fingerprint, from ssh-keyscan/ssh-keygen").setRequired(true))
    .addIntegerOption(o => o.setName("port").setDescription("SSH port (default 22)").setMinValue(1).setMaxValue(65535)),
  new SlashCommandBuilder().setName("vps-list").setDescription("List VPSs registered in this bot"),
  new SlashCommandBuilder().setName("vps-status").setDescription("Check VPS hostname, uptime, disk and memory")
    .addStringOption(o => o.setName("name").setDescription("Registered VPS label").setRequired(true)),
  new SlashCommandBuilder().setName("deploy-node").setDescription("Deploy a public GitHub Node.js app to a registered VPS")
    .addStringOption(o => o.setName("vps").setDescription("Registered VPS label").setRequired(true))
    .addStringOption(o => o.setName("app").setDescription("App/service name: lowercase letters, numbers, hyphens").setRequired(true))
    .addStringOption(o => o.setName("repo").setDescription("Public HTTPS GitHub repository URL").setRequired(true))
    .addStringOption(o => o.setName("branch").setDescription("Branch (default main)")),
  new SlashCommandBuilder().setName("app-restart").setDescription("Restart an app deployed by this bot")
    .addStringOption(o => o.setName("vps").setDescription("Registered VPS label").setRequired(true))
    .addStringOption(o => o.setName("app").setDescription("App/service name").setRequired(true)),
  new SlashCommandBuilder().setName("remove-vps").setDescription("Remove a VPS record from this bot (does not destroy VPS)")
    .addStringOption(o => o.setName("name").setDescription("Registered VPS label").setRequired(true))
].map(x => x.toJSON());

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
  console.log(`Registered ${commands.length} slash commands.`);
}

const bot = new Client({ intents: [GatewayIntentBits.Guilds] });
bot.once(Events.ClientReady, c => console.log(`ALOOZ VPS Bot online as ${c.user.tag}`));

bot.on(Events.InteractionCreate, async i => {
  if (!i.isChatInputCommand()) return;
  if (!ADMIN_IDS.has(i.user.id)) return safeReply(i, "⛔ এই কমান্ড ব্যবহারের অনুমতি নেই।");

  try {
    const cmd = i.commandName;

    if (cmd === "add-vps") {
      const name = i.options.getString("name", true);
      const host = i.options.getString("host", true);
      const username = i.options.getString("username", true);
      const keyPath = i.options.getString("key_path", true);
      const hostFingerprint = i.options.getString("fingerprint", true).replace(/^SHA256:/, "");
      const port = i.options.getInteger("port") || 22;

      if (!isLabel(name) || !/^[a-zA-Z0-9.-]{1,253}$/.test(host) ||
          !/^[a-z_][a-z0-9_-]{0,31}$/i.test(username) || !path.isAbsolute(keyPath) ||
          !/^[A-Za-z0-9+/]{20,}$/.test(hostFingerprint)) {
        return safeReply(i, "Invalid VPS details. Check label, host, username, absolute key path and SHA256 fingerprint.");
      }
      const all = loadServers();
      if (all.some(s => s.name.toLowerCase() === name.toLowerCase())) return safeReply(i, "এই নামে VPS আগে থেকেই আছে।");
      all.push({ name, host, username, keyPath, hostFingerprint, port });
      saveServers(all);
      return safeReply(i, `✅ **${name}** VPS যোগ হয়েছে। SSH host fingerprint verification চালু আছে।`);
    }

    if (cmd === "vps-list") {
      const all = loadServers();
      return safeReply(i, all.length ? all.map(s => `• **${s.name}** — \`${s.username}@${s.host}:${s.port || 22}\``).join("\n") : "কোনো VPS যোগ করা হয়নি।");
    }

    if (cmd === "remove-vps") {
      const name = i.options.getString("name", true);
      const all = loadServers();
      const next = all.filter(s => s.name.toLowerCase() !== name.toLowerCase());
      if (next.length === all.length) return safeReply(i, "VPS পাওয়া যায়নি।");
      saveServers(next);
      return safeReply(i, `🗑️ **${name}** bot inventory থেকে সরানো হয়েছে। VPS delete করা হয়নি।`);
    }

    if (cmd === "vps-status") {
      await i.deferReply({ ephemeral: true });
      const s = getServer(i.options.getString("name", true));
      if (!s) return safeReply(i, "VPS পাওয়া যায়নি। আগে /add-vps ব্যবহার করো।");
      const out = await checked(s, "printf 'HOST: '; hostname; printf 'UPTIME: '; uptime -p 2>/dev/null || uptime; printf '\\nDISK: '; df -h / | tail -1; printf '\\nMEMORY: '; free -h | awk '/Mem:/ {print $3 \" used / \" $2}'", 30000);
      return safeReply(i, `🖥️ **${s.name} status**\n\`\`\`\n${out}\n\`\`\``);
    }

    if (cmd === "deploy-node") {
      await i.deferReply({ ephemeral: true });
      const vpsName = i.options.getString("vps", true);
      const app = i.options.getString("app", true);
      const repo = i.options.getString("repo", true);
      const branch = i.options.getString("branch") || "main";
      const s = getServer(vpsName);
      if (!s) return safeReply(i, "VPS পাওয়া যায়নি। আগে /add-vps ব্যবহার করো।");
      if (!isApp(app)) return safeReply(i, "App name lowercase letters, numbers এবং hyphens দিয়ে দাও।");
      const u = new URL(repo);
      if (u.protocol !== "https:" || u.hostname !== "github.com" ||
          !/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/?$/.test(u.pathname)) {
        return safeReply(i, "শুধু public HTTPS GitHub repository URL দেওয়া যাবে।");
      }
      if (!/^[A-Za-z0-9._/-]{1,80}$/.test(branch) || branch.startsWith("-") || branch.includes("..")) {
        return safeReply(i, "Branch name invalid.");
      }

      const repoUrl = `https://github.com${u.pathname.replace(/\/$/, "")}.git`;
      const appDir = `/opt/alooz-apps/${app}`;
      const unit = `[Unit]
Description=ALOOZ app ${app}
After=network.target
[Service]
Type=simple
WorkingDirectory=${appDir}
ExecStart=/usr/bin/npm start
Restart=on-failure
RestartSec=5
User=${s.username}
Environment=NODE_ENV=production
[Install]
WantedBy=multi-user.target
`;
      const b64 = Buffer.from(unit).toString("base64");
      const script = [
        "set -e",
        "command -v git >/dev/null || { echo 'Install git first'; exit 1; }",
        "command -v node >/dev/null || { echo 'Install Node.js 20+ first'; exit 1; }",
        `sudo mkdir -p /opt/alooz-apps && sudo chown ${sh(s.username)}:${sh(s.username)} /opt/alooz-apps`,
        `if [ -d ${sh(appDir + "/.git")} ]; then git -C ${sh(appDir)} fetch --depth 1 origin ${sh(branch)} && git -C ${sh(appDir)} checkout ${sh(branch)} && git -C ${sh(appDir)} reset --hard FETCH_HEAD; else git clone --depth 1 --branch ${sh(branch)} ${sh(repoUrl)} ${sh(appDir)}; fi`,
        `cd ${sh(appDir)} && (npm ci --omit=dev || npm install --omit=dev)`,
        `echo ${sh(b64)} | base64 -d | sudo tee ${sh(`/etc/systemd/system/alooz-${app}.service`)} >/dev/null`,
        "sudo systemctl daemon-reload",
        `sudo systemctl enable --now ${sh(`alooz-${app}.service`)}`,
        `sudo systemctl --no-pager --full status ${sh(`alooz-${app}.service`)} | head -20`
      ].join("\n");
      const result = await checked(s, `bash -lc ${sh(script)}`, 300000);
      return safeReply(i, `🚀 **${app}** deploy complete on **${s.name}**\n\`\`\`\n${result.slice(0, 1300)}\n\`\`\`\nশুধু নিজের বা অনুমোদিত VPS এবং trusted repository ব্যবহার করো।`);
    }

    if (cmd === "app-restart") {
      await i.deferReply({ ephemeral: true });
      const s = getServer(i.options.getString("vps", true));
      const app = i.options.getString("app", true);
      if (!s || !isApp(app)) return safeReply(i, "VPS বা app name সঠিক নয়।");
      const out = await checked(s, `sudo systemctl restart ${sh(`alooz-${app}.service`)} && sudo systemctl is-active ${sh(`alooz-${app}.service`)}`, 30000);
      return safeReply(i, `♻️ **${app}**: ${out}`);
    }
  } catch (err) {
    console.error(err);
    return safeReply(i, `❌ কাজটি সম্পন্ন হয়নি: ${String(err.message || err).slice(0, 1100)}`);
  }
});

(async () => {
  await registerCommands();
  await bot.login(DISCORD_TOKEN);
})().catch(err => {
  console.error("Bot startup failed:", err);
  process.exit(1);
});
