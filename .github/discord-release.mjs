// Meldet ein veröffentlichtes NEXUS-Release in Discord (über einen Webhook). Die Nachricht ist auf Englisch.
// Läuft als GitHub Action im öffentlichen Download-Repository (dort unter .github/discord-release.mjs).
// Das Original mit den Tests liegt im Code-Repository unter scripts/discord-release.mjs; beide Dateien sind gleich.
// Die Webhook-Adresse ist geheim und kommt nur aus dem GitHub-Secret DISCORD_WEBHOOK_URL.

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const MAX_TEXT = 900;
const BOT_NAME = "NEXUS Updates";
// Im öffentlichen Download-Repository liegt das Logo woanders; dort gibt NEXUS_ICON_PATH den Ort an.
const ICON = process.env.NEXUS_ICON_PATH || new URL("../src-tauri/icons/icon.png", import.meta.url);

/** Name und Profilbild (das NEXUS-Logo) für den Webhook, so wie Discord sie erwartet. */
export function buildProfile(iconPath = ICON) {
  const png = readFileSync(iconPath);
  return { name: BOT_NAME, avatar: `data:image/png;base64,${png.toString("base64")}` };
}

/** Kurzer Text: alles vor dem Hinweis-/Deinstallations-/Prüfsummen-Teil des Release-Textes (englisch oder deutsch). */
export function shortText(body) {
  const lines = String(body ?? "").replace(/\r/g, "").split("\n");
  const end = lines.findIndex((l) => /^\s*(Note\s*:|Uninstall\s*:|Hinweis\s*:|Deinstallieren\s*:|SHA-?256\b)/i.test(l));
  let text = (end === -1 ? lines : lines.slice(0, end))
    .filter((l) => !/^#\s/.test(l)) // Überschrift steht schon im Titel
    .join("\n")
    .trim();
  if (text.length > MAX_TEXT) {
    text = text.slice(0, MAX_TEXT).replace(/\s+\S*$/, "") + " …";
  }
  return text;
}

/** Der Windows-Installer unter den angehängten Dateien (NEXUS_x.y.z_x64-setup.exe). */
export function findInstaller(assets) {
  const list = Array.isArray(assets) ? assets : [];
  return (
    list.find((a) => /_x64-setup\.exe$/i.test(a?.name ?? "")) ??
    list.find((a) => /\.exe$/i.test(a?.name ?? "")) ??
    null
  );
}

/** Baut die Discord-Nachricht aus den Release-Daten von GitHub. */
export function buildPayload(release) {
  const version = String(release.tag_name ?? "").replace(/^v/i, "");
  const installer = findInstaller(release.assets);
  const text = shortText(release.body);

  const links = [];
  if (installer) {
    links.push(`⬇️ **[Download (${installer.name})](${installer.browser_download_url})**`);
  }
  links.push(`📄 [Release page](${release.html_url})`);

  const parts = [];
  if (text) parts.push(text);
  parts.push(links.join("\n"));
  if (installer) {
    parts.push("-# The installer is not signed. Windows may show a warning: “More info” → “Run anyway”.");
  }

  return {
    username: BOT_NAME,
    content: `🚀 **Update available: NEXUS ${version}**`,
    embeds: [
      {
        title: release.name || `NEXUS ${version}`,
        url: release.html_url,
        description: parts.join("\n\n"),
        color: 0xc8aa6e,
        timestamp: release.published_at || undefined,
      },
    ],
    // Nichts aus dem Release-Text darf @everyone oder Personen anpingen.
    allowed_mentions: { parse: [] },
  };
}

async function loadRelease() {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
  if (event.release) return event.release;

  // Manueller Testlauf: gewünschte oder neueste Version von GitHub holen.
  const tag = (process.env.RELEASE_TAG || "").trim();
  const repo = process.env.GITHUB_REPOSITORY;
  const url = `https://api.github.com/repos/${repo}/releases/${tag ? `tags/${tag}` : "latest"}`;
  const res = await fetch(url, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
    },
  });
  if (!res.ok) throw new Error(`Release ${tag || "(neuestes)"} nicht gefunden (GitHub antwortet ${res.status}).`);
  return res.json();
}

async function main() {
  const webhook = (process.env.DISCORD_WEBHOOK_URL || "").trim();
  if (!webhook) {
    console.log("::warning::Kein DISCORD_WEBHOOK_URL hinterlegt – es wird nichts an Discord gesendet.");
    return;
  }
  const release = await loadRelease();
  if (release.draft) {
    console.log("Entwurf – wird nicht gemeldet.");
    return;
  }
  // Profilbild und Name am Webhook setzen. Klappt das nicht, wird trotzdem gemeldet.
  try {
    const profil = await fetch(webhook, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(buildProfile()),
    });
    if (!profil.ok) console.log(`::warning::Profilbild konnte nicht gesetzt werden (Status ${profil.status}).`);
  } catch {
    console.log("::warning::Profilbild konnte nicht gesetzt werden.");
  }

  const res = await fetch(webhook, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(buildPayload(release)),
  });
  if (!res.ok) {
    // Antworttext nicht ausgeben: er kann Teile der geheimen Adresse enthalten.
    throw new Error(`Discord hat die Nachricht abgelehnt (Status ${res.status}).`);
  }
  console.log(`Gemeldet: ${release.tag_name}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
