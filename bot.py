import os, asyncio, datetime, subprocess
from pathlib import Path
from dotenv import load_dotenv
import discord
from discord import FFmpegPCMAudio
from utils import combine_audio, transcribe, summarize, pdf_from_markdown

load_dotenv()
TOKEN = os.getenv("DISCORD_TOKEN")
CHUNK_SEC = 300  # 5m
ROOT = Path(__file__).parent
RECORD_DIR = ROOT / "recordings"
SUMMARY_DIR = ROOT / "summaries"
SILENCE_MP3 = ROOT / "silence.mp3"

RECORD_DIR.mkdir(exist_ok=True)
SUMMARY_DIR.mkdir(exist_ok=True)

# generate 1s silence loop if missing
if not SILENCE_MP3.exists():
    subprocess.run([
        "ffmpeg", "-y",
        "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000",
        "-t", "1", "-acodec", "libmp3lame", "-q:a", "9",
        str(SILENCE_MP3)
    ], check=True)

intents = discord.Intents.default()
intents.message_content = True
intents.voice_states = True
bot = discord.Bot(intents=intents)

class Session:
    def __init__(self):
        self.active = False
        self.vc = None
        self.chunks = []
        self.task = None

session = Session()

async def keepalive(vc: discord.VoiceClient):
    if vc.is_playing(): return
    src = FFmpegPCMAudio(
        str(SILENCE_MP3),
        before_options="-stream_loop -1 -loglevel quiet",
        options="-ac 2 -ar 48000 -loglevel quiet"
    )
    vc.play(src, after=lambda e: asyncio.run_coroutine_threadsafe(keepalive(vc), bot.loop))

async def join_once(inter):
    if session.vc and session.vc.is_connected(): return
    if not inter.author.voice or not inter.author.voice.channel:
        raise RuntimeError("Join a voice channel first.")
    session.vc = await inter.author.voice.channel.connect()
    await keepalive(session.vc)

async def on_chunk_end(sink, inter, fname: Path):
    for _, audio in sink.audio_data.items():
        with open(fname, "wb") as f:
            f.write(audio.file.read())
    session.chunks.append(fname)

async def recorder(inter):
    while session.active:
        fname = RECORD_DIR / f"{datetime.datetime.now(datetime.timezone.utc):%Y%m%d_%H%M%S}.wav"
        sink = discord.sinks.WaveSink()
        try:
            session.vc.start_recording(sink, on_chunk_end, inter, fname)
        except Exception as e:
            print("❌ start_recording error:", e)
            break
        await asyncio.sleep(CHUNK_SEC)
        session.vc.stop_recording()
    # final flush
    if hasattr(session.vc, "recording") and session.vc.recording:
        session.vc.stop_recording()
    session.task = None

@bot.slash_command(description="Start or stop recording")
async def record(inter, action: discord.Option(str, choices=["start","stop"])):
    await inter.response.defer(ephemeral=True)
    if action == "start":
        if session.active:
            return await inter.followup.send("⚠️ Already recording.", ephemeral=True)
        try:
            await join_once(inter)
        except Exception as e:
            return await inter.followup.send(f"❌ {e}", ephemeral=True)
        session.active = True
        session.task = asyncio.create_task(recorder(inter))
        return await inter.followup.send("🎙️ Recording… Use `/record stop` to finish.", ephemeral=True)
    else:
        if not session.active:
            return await inter.followup.send("⚠️ Not recording.", ephemeral=True)
        session.active = False
        await inter.followup.send("⏳ Processing…", ephemeral=True)
        await session.task
        merged = combine_audio(session.chunks)
        transcript = transcribe(merged)
        md = summarize(transcript)
        pdf_path = SUMMARY_DIR / f"meeting_{datetime.datetime.now(datetime.timezone.utc):%Y%m%d_%H%M%S}.pdf"
        pdf_from_markdown(md, pdf_path)
        await inter.user.send("📄 Meeting summary:", file=discord.File(pdf_path))
        session.__init__()

@bot.slash_command(description="Process existing WAV")
async def process(inter, filename: discord.Option(str, description="e.g. 20250714_101500.wav")):
    await inter.response.defer(ephemeral=True)
    if session.active:
        return await inter.followup.send("⚠️ Stop recording first.", ephemeral=True)
    wav = RECORD_DIR / filename
    if not wav.exists():
        return await inter.followup.send(f"❌ `{filename}` not found.", ephemeral=True)
    await inter.followup.send("⏳ Processing file…", ephemeral=True)
    transcript = transcribe(wav)
    md = summarize(transcript)
    pdf_path = SUMMARY_DIR / f"processed_{wav.stem}.pdf"
    pdf_from_markdown(md, pdf_path)
    await inter.user.send(f"📄 Summary for `{filename}`:", file=discord.File(pdf_path))
    await inter.followup.send("✅ Done! Check your DMs.", ephemeral=True)

@bot.slash_command(description="Leave voice channel & reset")
async def leave(inter):
    await inter.response.defer(ephemeral=True)
    if session.vc and session.vc.is_connected():
        await session.vc.disconnect()
    session.__init__()
    await inter.followup.send("👋 Left & reset session.", ephemeral=True)

@bot.slash_command(description="Show bot status")
async def status(inter):
    await inter.respond(
        f"**Status**: {'Recording' if session.active else 'Idle'} | Chunks: {len(session.chunks)}",
        ephemeral=True
    )

@bot.event
async def on_ready():
    await bot.sync_commands()
    print(f"🤖 Logged in as {bot.user} — ready.")

bot.run(TOKEN)
