"""
Discord channel listener: saves the text + image attachments of every new
message posted in one channel.

Output layout:
    downloads/<YYYYmmdd_HHMMSS>_<message_id>/
        message.json     author, timestamp, text, attachment info
        <attachment files>

Setup:
    pip install -r requirements.txt
    .env next to this script:
        DISCORD_TOKEN=...        bot token
        DISCORD_SERVER_ID=...    optional, only this server
        DISCORD_CHANNEL_ID=...   optional, only this channel
    python listener.py
"""

import json
import os
from pathlib import Path

import discord
from dotenv import load_dotenv

load_dotenv(Path(__file__).parent / ".env")

TOKEN = os.environ["DISCORD_TOKEN"]
SERVER_ID = int(os.getenv("DISCORD_SERVER_ID") or 0)
CHANNEL_ID = int(os.getenv("DISCORD_CHANNEL_ID") or 0)
OUT_DIR = Path(__file__).parent / "downloads"

IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"}

intents = discord.Intents.default()
intents.message_content = True  # also enable it in the Developer Portal
client = discord.Client(intents=intents)


def is_image(att: discord.Attachment) -> bool:
    if att.content_type and att.content_type.startswith("image/"):
        return True
    return Path(att.filename).suffix.lower() in IMAGE_EXTS


async def save_message(msg: discord.Message):
    images = [a for a in msg.attachments if is_image(a)]
    # Embedded images (e.g. webhook/bot posts that use embeds instead of attachments)
    embed_urls = [e.image.url for e in msg.embeds if e.image and e.image.url]
    embed_texts = [
        "\n".join(filter(None, [e.title, e.description])) for e in msg.embeds
    ]

    if not images and not embed_urls and not msg.content:
        return

    stamp = msg.created_at.strftime("%Y%m%d_%H%M%S")
    folder = OUT_DIR / f"{stamp}_{msg.id}"
    folder.mkdir(parents=True, exist_ok=True)

    saved = []
    for att in images:
        path = folder / att.filename
        await att.save(path)
        saved.append(att.filename)

    meta = {
        "id": msg.id,
        "author": str(msg.author),
        "created_at": msg.created_at.isoformat(),
        "text": msg.content,
        "embed_text": [t for t in embed_texts if t],
        "images": saved,
        "embed_image_urls": embed_urls,
        "jump_url": msg.jump_url,
    }
    (folder / "message.json").write_text(
        json.dumps(meta, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    print(f"[saved] {folder.name}  text={msg.content[:60]!r}  images={saved}")


@client.event
async def on_ready():
    print(f"Logged in as {client.user}, server={SERVER_ID or 'any'} channel={CHANNEL_ID or 'any'}")


@client.event
async def on_message(msg: discord.Message):
    if SERVER_ID and (msg.guild is None or msg.guild.id != SERVER_ID):
        return
    if CHANNEL_ID and msg.channel.id != CHANNEL_ID:
        return
    try:
        await save_message(msg)
    except Exception as e:
        print(f"[error] message {msg.id}: {e}")


client.run(TOKEN)
