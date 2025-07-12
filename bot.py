import os, asyncio, datetime, uuid, subprocess, tempfile, shutil
from pathlib import Path
from dotenv import load_dotenv

import discord
from discord.ext import commands
from utils import combine_audio, transcribe, summarize, pdf_from_markdown

load_dotenv()
TOKEN = os.getenv("DISCORD_TOKEN")
GUILD_ID = int(os.getenv("GUILD_ID")) if os.getenv("GUILD_ID") else None
RECORD_DIR = Path("recordings")
RECORD_DIR.mkdir(exist_ok=True)

intents = discord.Intents.default()
intents.message_content = True
intents.voice_states = True

bot = commands.Bot(command_prefix="/", intents=intents)

# ---------- helpers ----------
class Session:
    def __init__(self):
        self.active = False
        self.files: list[Path] = []
        self.vc: discord.VoiceClient | None = None

session = Session()
CHUNK_SEC = 300  # five minutes

async def finished_callback(sink: discord.sinks.WaveSink, ctx, filename: Path):
    """Called every time a chunk finishes."""
    for user, audio in sink.audio_data.items():
        with open(filename, "wb") as fp:
            fp.write(audio.file.read())
    session.files.append(filename)

async def start_chunk(ctx):
    fn = RECORD_DIR / f"{datetime.datetime.utcnow():%Y%m%d_%H%M%S}.wav"
    sink = discord.sinks.WaveSink()
    session.vc.start_recording(sink, finished_callback, ctx, fn)
    await asyncio.sleep(CHUNK_SEC)
    if session.active:  # rotate
        session.vc.stop_recording()  # triggers callback
        await start_chunk(ctx)

# ---------- slash commands ----------
@bot.slash_command(description="Join your voice channel")
async def join(ctx: discord.ApplicationContext):
    if not ctx.author.voice:
        return await ctx.respond("You must be in a voice channel.")
    session.vc = await ctx.author.voice.channel.connect()
    await ctx.respond("Joined voice channel.")

@bot.slash_command(description="Leave voice channel")
async def leave(ctx: discord.ApplicationContext):
    if session.vc:
        await session.vc.disconnect()
    session.active = False
    session.files.clear()
    await ctx.respond("Left voice channel.")

@bot.slash_command(description="Recording controls")
async def record(ctx: discord.ApplicationContext, action: discord.Option(str, choices=["start", "stop"])):
    if action == "start":
        if session.active:
            return await ctx.respond("Already recording.")
        if not ctx.author.voice or not ctx.author.voice.channel:
            return await ctx.respond("Join a voice channel first.")
        session.active = True
        if not session.vc:
            session.vc = await ctx.author.voice.channel.connect()
        await ctx.respond("Recording…")
        asyncio.create_task(start_chunk(ctx))
    else:  # stop
        if not session.active:
            return await ctx.respond("Not recording.")
        session.active = False
        session.vc.stop_recording()
        await ctx.respond("Processing audio…⏳")

        # ---------- pipeline ----------
        combined = combine_audio(session.files)
        transcript = transcribe(combined)
        md_summary = summarize(transcript)
        pdf_path = pdf_from_markdown(md_summary)

        await ctx.author.send(
            content="Here’s your meeting summary:",
            file=discord.File(pdf_path)
        )
        # cleanup
        shutil.rmtree(RECORD_DIR)
        RECORD_DIR.mkdir(exist_ok=True)
        session.files.clear()

bot.run(TOKEN)
