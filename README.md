# sticker-whatsapp-bridge
A CLI program for downloading and uploading WhatsApp stickers.

Built with [Baileys](https://github.com/WhiskeySockets/Baileys).

If you want a user-friendly GUI, checkout
[sticker-convert](https://github.com/laggykiller/sticker-convert) which uses this project.

```
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
  -x, --no-write-meta Do not write metadata of pack to xxx.meta
```

## Running
You may install [precompiled executables from Releases](https://github.com/laggykiller/sticker-whatsapp-bridge/releases)

You may also run directly from source code using `bun`
```
bun install
bun run ./src/swb.ts
```

## Setup
1. Login with `swb login`, this will show QR code for logging in WhatsApp web
2. Scan QR code with WhatsApp `Linked devices > Link a device`

## How to receive stickers
- Receiving stickers/stickerpack: `swb recv`
- Receiving 3 stickers/stickerpack then stop: `swb recv -c 3`
- Receiving stickers/stickerpack to specified destination: `swb recv -d ./my/dest/`
- This will create a new WhatsApp group named `sticker-whatsapp-bridge`
(Name could be controlled with `--group-name`). You can send/forward
stickers/stickerpack to the group and they will be downloaded.

## How to send stickers
- Sending stickers: `swb send -p ./0.webp -p ./1.png -p ./2.was`
- Sending stickerpack (`.wastickers`): `swb send -p ./mypack.wastickers`
- Sending stickerpack (`.wastickers`): `swb send -p ./mypack.zip`
- This will create a new WhatsApp group named `sticker-whatsapp-bridge`
(Name could be controlled with `--group-name`) and stickers/stickerpack will
be sent to that group

### Format of `.wastickers` stickerpack
- This is the format of stickerpack you export from Sticker Maker, a 3rd party WhatsApp stickers application [[iOS version](https://apps.apple.com/us/app/sticker-maker-studio/id1443326857) | [Android version](https://play.google.com/store/apps/details?id=com.marsvard.stickermakerforwhatsapp)]
- For stickers and cover file requirement, see: https://github.com/WhatsApp/stickers/tree/main/Android
- stickers in webp format, any name acceptable
- cover in png format, any name acceptable
- `title.txt` containing pack title
- `author.txt` containing pack author

### Format of `.zip` stickerpack
- This is the format of stickerpack you download from `swb recv`
- stickers as `<2-digit-number>_<...>.<webp|png>`, e.g. `00_xyzxyzxyz.webp` or `01_foobar.png`
- cover in any name that does not start with 2-digit-number

### Format of emoji json
If a sticker pack contains `00_xyzxyzxyz.webp` and `01_foobar.png`, emoji json should
look like:
```json
{
  "00_xyzxyzxyz": "😊😄",
  "01_foobar": ""
}
```

### Format of sticker pack metadata file (xxx.meta)
If a metadata file exist at the same directory with the sticker pack file
(e.g. `input/xxx.zip` and `input/xxx.meta`), metadata from the file will be used.

Note that you can download and create metadata file by using `--write-meta` or `-x`.

Example:
```json
{
  "name": "Sample sticker pack",
  "publisher": "My name",
  "packDescription": "This is a sample sticker pack",
  "stickerPackId": "sample.sticker.pack",
  "caption": "This is a sample sticker pack",
}
```

## Current limitations
- Bun precompiled version cannot use `sharp` for converting between webp and png
- Cannot receive metadata associated with sticker