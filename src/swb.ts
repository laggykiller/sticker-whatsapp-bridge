import { Boom } from "@hapi/boom";
import makeWASocket, {
  Browsers,
  DisconnectReason,
  downloadContentFromMessage,
  makeCacheableSignalKeyStore,
  proto,
  Sticker,
  useMultiFileAuthState,
  WAMessage,
} from "baileys/src";
import JSZip from "jszip";
import {
  createWriteStream,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFile,
} from "node:fs";
import { pipeline } from "node:stream";
import { parseArgs } from "node:util";
import path from "path";
import pino from "pino";
import QRCode from "qrcode";

const VERSION = "v1.0.0";
process.env.BAILEYS_LOG = process.env.BAILEYS_LOG ?? 'false'

type WASocket = ReturnType<typeof makeWASocket>;
interface GenericJsonMsg {
  event: string;
}
interface StickerPackMeta {
  name?: string;
  publisher?: string;
  packDescription?: string;
  stickerPackId?: string;
  caption?: string;
}
interface VersionJsonMsg extends GenericJsonMsg {
  event: "version";
  message: string;
}
interface ErrorJsonMsg extends GenericJsonMsg {
  event: "error";
  message: string;
}
interface LoginJsonMsg extends GenericJsonMsg {
  event: "login";
  mode: "pairing_code" | "qr";
  code: string;
}
interface RecvJsonMsg extends GenericJsonMsg {
  event: "recv";
  type: "pack" | "sticker";
  ext: ".zip";
  count: number;
  fname: string;
}
interface RecvStickerJsonMsg extends RecvJsonMsg {
  type: "sticker";
}
interface RecvPackJsonMsg extends RecvJsonMsg, StickerPackMeta {
  type: "pack";
}
interface SendJsonMsg extends GenericJsonMsg {
  event: "send";
  type: "pack" | "sticker";
  fpath: string;
}

interface EmojiDict {
  [key: string]: string;
}
type ActionType = "login" | "logout" | "send" | "recv";
interface Counter {
  cnt: number;
}

const { values, positionals } = parseArgs({
  options: {
    version: { type: "boolean", short: "v" },
    help: { type: "boolean", short: "h" },
    "group-name": {
      type: "string",
      short: "g",
      default: "sticker-whatsapp-bridge",
    },
    json: { type: "boolean", short: "j" },
    "auth-info": { type: "string", short: "a", default: "./auth_info_baileys" },
    platform: { type: "string", short: "f", default: "appropriate" },
    browser: { type: "string", short: "b", default: "Chrome" },
    phone: { type: "string", short: "o" },
    path: { type: "string", short: "p", multiple: true },
    name: { type: "string", short: "n" },
    publisher: { type: "string", short: "b", default: "Baileys" },
    "pack-id": { type: "string", short: "i" },
    description: { type: "string", short: "e" },
    "emoji-json": { type: "string", short: "m" },
    count: { type: "string", short: "c" },
    dest: { type: "string", short: "d", default: "./output" },
    "no-write-meta": { type: "boolean", short: "x" },
  },
  allowPositionals: true,
});

if (values.help) {
  console.log(`
Usage: swb COMMAND [OPTIONS]

COMMAND:
  login               Login to WhatsApp
  logout              Logout of WhatsApp
  send                Send stickerpack or sticker
  recv                Receive stickerpacks or sticker

OPTIONS:
  -h, --help          Show this help message
  -v, --version       Show version
  -g, --group-name    Group name (Default: sticker-whatsapp-bridge)
  -j, --json          JSON console output mode
  -a, --auth-info     Directory to auth info (Default: ./auth_info_baileys)
  -f, --platform      Platform name
                      Choices: appropriate (Default), ubuntu, macOS, baileys, windows
  -b, --browser       Browser name (Default: Chrome)

OPTIONS (For login):
  -o, --phone         Phone number without plus sign or bracket
                      For login using pairing code
                      Example: +1 (234) 567-8901 -> 12345678901
                      (If not supplied, will login using QR code)

OPTIONS (For send):
  -p, --path          Stickerpack (.zip / .wastickers) / sticker to upload
  -n, --name          Name of pack (Default: File name of .zip / .wastickers)
  -b, --publisher     Publisher of pack (Default: Baileys)
  -i, --pack-id       Pack ID
  -e, --description   Pack description
  -m, --emoji-json    Path to json containing emoji information of stickerpack
OPTIONS (For recv):
  -c, --count         Limit number of stickerpacks / sticker to receive
                      (Default: unlimited)
  -d, --dest          Directory to save received stickerpacks / sticker
                      (Default: ./output)
  -x, --no-write-meta Do not write metadata of pack to xxx.meta`);
  process.exit(values.help ? 0 : 1);
}

function error(msg: string) {
  console.error(
    values.json
      ? JSON.stringify({
          event: "error",
          message: msg,
        } as ErrorJsonMsg)
      : msg,
  );
}

if (values.version) {
  console.log(
    values.json
      ? JSON.stringify({ event: "version", message: VERSION } as VersionJsonMsg)
      : VERSION,
  );
  process.exit();
}

if (positionals.length > 1) {
  error("Only one COMMAND allowed (login / logout / send / recv)");
  process.exit(1);
}
if (positionals.length === 0) {
  error("At least one COMMAND required (login / logout / send / recv)");
  process.exit(1);
}
if (!["login", "logout", "send", "recv"].includes(positionals[0])) {
  error("Invalid COMMAND (login / logout / send / recv)");
  process.exit(1);
}
let platform: (browser: string) => [string, string, string];
switch (values.platform) {
  case "appropriate":
    platform = Browsers.appropriate;
    break;
  case "ubuntu":
    platform = Browsers.ubuntu;
    break;
  case "macOS":
    platform = Browsers.macOS;
    break;
  case "baileys":
    platform = Browsers.baileys;
    break;
  case "windows":
    platform = Browsers.windows;
    break;
  default:
    error(
      "Invalid platform (appropriate / ubuntu / macOS / baileys / windows)",
    );
    process.exit(1);
}

const action = positionals[0] as ActionType;
class Group {
  private ready: boolean = false;
  private static instance?: Group;
  public groupID: string = "";

  constructor() {
    if (Group.instance) {
      return Group.instance;
    }
    this.ready = false;
  }

  async init(sock: WASocket, groupName: string) {
    if (this.ready === true) {
      return;
    }
    const rawJid = sock.user?.id ?? "";
    const selfJid = rawJid.replace(/:.*@/, "@");
    const groups = await sock.groupFetchAllParticipating();
    this.groupID =
      Object.keys(groups).find((i) => groups[i].subject === groupName) ??
      (await sock.groupCreate(groupName, [selfJid]).then((i) => i.id));
    Group.instance = this;
    this.ready = true;
  }
}

function createDir(dir: string) {
  try {
    mkdirSync(dir, { recursive: true });
  } catch (err) {
    error(`Cannot create directory ${dir}`);
    process.exit(1);
  }
}

async function sendSticker(sock: WASocket, group: Group, fpath: string) {
  await sock.sendMessage(group.groupID, {
    sticker: readFileSync(fpath),
  });

  console.log(
    values.json
      ? JSON.stringify({
          event: "send",
          type: "sticker",
          fpath: fpath,
        } as SendJsonMsg)
      : `Sent sticker ${fpath}`,
  );
}

async function sendWAS(sock: WASocket, group: Group, fpath: string) {
  const anchorMsg = await sock.sendMessage(group.groupID, { text: " " });
  await sock.sendMessage(
    group.groupID,
    {
      sticker: readFileSync(fpath),
      mimetype: "application/was",
      // @ts-ignore
      isLottie: true,
      isAnimated: true,
    },
    { quoted: anchorMsg },
  );

  console.log(
    values.json
      ? JSON.stringify({
          event: "send",
          type: "sticker",
          fpath: fpath,
        } as SendJsonMsg)
      : `Sent sticker ${fpath}`,
  );
}

async function sendStickerPack(sock: WASocket, group: Group, fpath: string) {
  const data = readFileSync(fpath);
  const zip = await JSZip.loadAsync(data);
  const stickers: Sticker[] = [];

  let meta: StickerPackMeta | null = null;
  const metaPath = path.join(
    path.parse(fpath).dir,
    path.parse(fpath).name + ".meta",
  );
  try {
    const metaData = readFileSync(metaPath, "utf8");
    meta = JSON.parse(metaData) as StickerPackMeta;
  } catch {}

  let cover: Buffer | null = null;
  let packName = values.name ?? meta?.name ?? path.parse(fpath).name;
  let packPublisher = values.publisher ?? meta?.publisher;
  const ftype = fpath.split(".").at(-1) ?? "";
  const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });

  if (!["wastickers", "zip"].includes(ftype)) {
    error(`${fpath} has invalid extension '${ftype}'`);
    return;
  }

  const emojiJson = values["emoji-json"]
    ? readFileSync(values["emoji-json"], "utf8")
    : "{}";
  const emojis: EmojiDict = JSON.parse(emojiJson);

  for (const relativePath in zip.files) {
    const file = zip.files[relativePath];
    if (!file) continue;
    const buffer = await file.async("nodebuffer");

    if (
      (ftype === "wastickers" && relativePath.toLowerCase().endsWith("png")) ||
      (ftype === "zip" && /^\d+$/.test(relativePath.slice(0, 2)) === false)
    ) {
      cover = buffer;
    } else if (relativePath === "title.txt") {
      packName = await file.async("text");
    } else if (relativePath === "author.txt") {
      packPublisher = await file.async("text");
    } else {
      const emojiStr = emojis[path.parse(relativePath).name] ?? undefined;
      stickers.push({
        data: buffer,
        emojis: emojiStr
          ? Array.from(segmenter.segment(emojiStr), (s) => s.segment)
          : undefined,
      });
    }
  }

  if (cover === null) {
    error(`Error: ${fpath} missing cover`);
    return;
  }

  await sock.sendMessage(group.groupID, {
    stickerPack: {
      name: packName,
      publisher: packPublisher,
      cover: cover,
      stickers: stickers,
      packId: meta?.stickerPackId ?? values["pack-id"],
      description: meta?.packDescription ?? values.description,
    },
  });

  console.log(
    values.json
      ? JSON.stringify({
          event: "send",
          type: "pack",
          fpath: fpath,
        } as SendJsonMsg)
      : `Sent sticker pack ${fpath}`,
  );
}

async function handleSend(sock: WASocket, group: Group) {
  for (const p of values.path ?? []) {
    switch (p.toLowerCase().split(".").at(-1)) {
      case "wastickers":
        await sendStickerPack(sock, group, p);
        break;
      case "zip":
        await sendStickerPack(sock, group, p);
        break;
      case "was":
        await sendWAS(sock, group, p);
        break;
      case "webp":
        await sendSticker(sock, group, p);
        break;
      case "png":
        await sendSticker(sock, group, p);
        break;
      default:
        error(`Error: Invalid format ${p}`);
    }
  }
}

async function recvSticker(
  sticker: proto.Message.IStickerMessage,
  cnt: number,
  timestamp: number,
) {
  let ext: string;
  switch (sticker.mimetype) {
    case "image/webp":
      ext = ".webp";
      break;
    case "image/png":
      ext = ".png";
      break;
    case "application/was":
      ext = ".was";
      break;
    default:
      error(
        `Error: Unknown mimetype for received sticker: ${sticker.mimetype}`,
      );
      return;
  }
  const fname = `${cnt}-${timestamp}${ext}`;

  const stream = await downloadContentFromMessage(
    {
      mediaKey: sticker.mediaKey,
      directPath: sticker.directPath,
      url: `https://mmg.whatsapp.net${sticker.directPath}`,
    },
    "sticker",
    {},
  );

  createDir(values.dest);
  const outPath = path.join(values.dest, fname);
  pipeline(stream, createWriteStream(outPath), (err) => {
    if (err) {
      error(`Failed to write ${fname}: ${err}`);
    } else {
      console.log(
        values.json
          ? JSON.stringify({
              event: "recv",
              type: "sticker",
              ext: ext,
              count: cnt,
              fname: fname,
            } as RecvStickerJsonMsg)
          : `Received #${cnt} ${fname}`,
      );
    }
  });
}

async function recvStickerPack(
  pack: proto.Message.IStickerPackMessage,
  cnt: number,
  timestamp: number,
) {
  const fname = `${cnt}-${timestamp}.zip`;
  const stream = await downloadContentFromMessage(
    {
      mediaKey: pack.mediaKey,
      directPath: pack.directPath,
      url: `https://mmg.whatsapp.net${pack.directPath}`,
    },
    "sticker-pack",
    {},
  );
  const meta = {
    name: pack.name ?? undefined,
    publisher: pack.publisher ?? undefined,
    packDescription: pack.packDescription ?? undefined,
    stickerPackId: pack.stickerPackId ?? undefined,
    caption: pack.caption ?? undefined,
  } as StickerPackMeta;

  createDir(values.dest);
  const outPath = path.join(values.dest, fname);
  pipeline(stream, createWriteStream(outPath), (err) => {
    if (err) {
      error(`Failed to write ${fname}: ${err}`);
    } else {
      console.log(
        values.json
          ? JSON.stringify({
              event: "recv",
              type: "pack",
              ext: ".zip",
              count: cnt,
              fname: fname,
              ...meta,
            } as RecvPackJsonMsg)
          : `Received #${cnt} ${fname}`,
      );
    }
  });

  if (!values["no-write-meta"]) {
    const metaPath = path.join(values.dest, `${cnt}-${timestamp}.meta`);
    writeFile(metaPath, JSON.stringify(meta), "utf-8", (err) => {
      if (err) {
        error(`Failed to write ${metaPath}: ${err}`);
      }
    });
  }
}

async function handleRecv(message: WAMessage, counter: Counter) {
  const timestamp = new Date().valueOf();
  if (message.message?.stickerMessage) {
    recvSticker(message.message.stickerMessage, counter.cnt, timestamp);
    counter.cnt += 1;
  }
  if (message.message?.lottieStickerMessage) {
    recvSticker(
      message.message.lottieStickerMessage.message!
        .stickerMessage as proto.Message.IStickerMessage,
      counter.cnt,
      timestamp,
    );
    counter.cnt += 1;
  }
  if (message.message?.stickerPackMessage) {
    recvStickerPack(message.message.stickerPackMessage, counter.cnt, timestamp);
    counter.cnt += 1;
  }
}

async function login(sock: WASocket, qr: string) {
  if (action !== "login") {
    error("Not logged in");
    process.exit(1);
  }

  if (values.phone) {
    const code = await sock.requestPairingCode(values.phone);
    console.log(
      values.json
        ? JSON.stringify({
            event: "login",
            mode: "pairing_code",
            code: code,
          } as LoginJsonMsg)
        : `Login by entering pairing code: ${code}`,
    );
  } else {
    console.log(
      values.json
        ? JSON.stringify({
            event: "login",
            mode: "qr",
            code: qr,
          } as LoginJsonMsg)
        : await QRCode.toString(qr, { type: "terminal" }),
    );
  }
}

async function main() {
  const { state, saveCreds } = await useMultiFileAuthState(values["auth-info"]);
  const logger = pino({ level: "silent" });
  const group = new Group();
  const recvCounter: Counter = { cnt: 0 };
  const sock = makeWASocket({
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    browser: platform(values.browser),
    logger: logger,
    markOnlineOnConnect: false,
  });

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      await login(sock, qr);
    }

    if (connection === "open") {
      if (action !== "logout") {
        console.log(
          values.json
            ? JSON.stringify({ event: "login_success" } as GenericJsonMsg)
            : "Logged in",
        );
      }
      await group.init(sock, values["group-name"]);
      if (action === "login") {
        process.exit();
      }
      if (action === "logout") {
        await sock.logout();
      }
      if (action === "recv") {
        console.log(
          values.json
            ? JSON.stringify({ event: "recv_ready" } as GenericJsonMsg)
            : `Ready to recieve stickers / sticker pack from WhatsApp group ${values["group-name"]}`,
        );
      }
      if (action === "send") {
        await handleSend(sock, group);
        process.exit();
      }
    }

    if (connection === "close") {
      const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;

      switch (statusCode) {
        case DisconnectReason.restartRequired:
          main();
          break;
        case DisconnectReason.loggedOut:
          console.log(
            values.json
              ? JSON.stringify({ event: "logout" } as GenericJsonMsg)
              : "Logged out",
          );
          rmSync(values["auth-info"], { recursive: true, force: true });
          process.exit(action === "logout" ? 0 : 1);
        default:
          if (action === "logout") {
            console.log(
              values.json
                ? JSON.stringify({ event: "logout" } as GenericJsonMsg)
                : "Logged out",
            );
            rmSync(values["auth-info"], { recursive: true, force: true });
            process.exit();
          } else {
            error(`Disconnected for ${DisconnectReason[statusCode]}`);
            process.exit(1);
          }
      }
    }
  });

  sock.ev.on("messages.upsert", async ({ type, messages }) => {
    if (type == "notify") {
      for (const message of messages) {
        if (message.key.remoteJid === group.groupID) {
          await handleRecv(message, recvCounter);
          if (values.count && parseInt(values.count) === recvCounter.cnt) {
            console.log(
              values.json
                ? JSON.stringify({
                    event: "recv_end",
                  } as GenericJsonMsg)
                : `Received limit ${values.count}, exiting`,
            );
            process.exit();
          }
        }
      }
    }
  });

  sock.ev.on("creds.update", saveCreds);
}

main();
