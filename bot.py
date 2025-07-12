import os, asyncio, datetime
from pathlib import Path
from dotenv import load_dotenv
import discord
from utils import combine_audio, transcribe, summarize, pdf_from_markdown

# ── config ──────────────────────────────────────────────
load_dotenv()
TOKEN = os.getenv("DISCORD_TOKEN")
CHUNK_SEC = 300
RECORD_DIR  = Path("recordings"); RECORD_DIR.mkdir(exist_ok=True)
SUMMARY_DIR = Path("summaries");  SUMMARY_DIR.mkdir(exist_ok=True)

intents = discord.Intents.default()
intents.message_content = True
intents.voice_states   = True
bot = discord.Bot(intents=intents)

# ── session ─────────────────────────────────────────────
class Session:
    def __init__(self):
        self.active  : bool = False
        self.vc      : discord.VoiceClient | None = None
        self.chunks  : list[Path] = []
        self.task    : asyncio.Task | None = None
session = Session()

# ── helpers ─────────────────────────────────────────────
async def safe_connect(inter: discord.ApplicationContext) -> discord.VoiceClient:
    if session.vc and session.vc.is_connected():
        return session.vc
    for vc in bot.voice_clients:
        if vc.guild == inter.guild and vc.is_connected():
            session.vc = vc; return vc
    if not inter.author.voice or not inter.author.voice.channel:
        raise RuntimeError("You must join a voice channel first.")
    session.vc = await inter.author.voice.channel.connect()
    return session.vc

async def on_chunk_end(sink: discord.sinks.WaveSink, inter, fname: Path):
    for _, audio in sink.audio_data.items():
        with open(fname, "wb") as fp:
            fp.write(audio.file.read())
    session.chunks.append(fname)

async def recorder(inter):
    """Background task that slices 5-min chunks until session.active=False."""
    try:
        while session.active:
            fname = RECORD_DIR / f"{datetime.datetime.now(datetime.timezone.utc):%Y%m%d_%H%M%S}.wav"
            sink  = discord.sinks.WaveSink()
            session.vc.start_recording(sink, on_chunk_end, inter, fname)
            await asyncio.sleep(CHUNK_SEC)
            if session.vc.recording:
                session.vc.stop_recording()
        # flush final partial chunk after /stop
        if session.vc.recording:
            session.vc.stop_recording()
    finally:
        session.task = None   # allow new recordings later

# ── slash commands ─────────────────────────────────────
@bot.slash_command(description="Start or stop recording")
async def record(
    inter: discord.ApplicationContext,
    action: discord.Option(str, choices=["start", "stop"])
):
    await inter.response.defer(ephemeral=True)

    if action == "start":
        if session.active:
            return await inter.followup.send("⚠️ Already recording.", ephemeral=True)
        try:
            await safe_connect(inter)
        except RuntimeError as e:
            return await inter.followup.send(str(e), ephemeral=True)

        session.active = True
        session.task   = asyncio.create_task(recorder(inter))
        return await inter.followup.send("🎙️ Recording… (use `/record stop` to finish)", ephemeral=True)

    # action == stop
    if not session.active:
        return await inter.followup.send("⚠️ Not recording.", ephemeral=True)

    session.active = False
    await session.task                # wait for recorder to finish
    await inter.followup.send("⏳ Processing…", ephemeral=True)

    merged = combine_audio(session.chunks)
    transcript = transcribe(merged)
    md_summary = summarize(transcript)
    pdf_path = SUMMARY_DIR / f"meeting_{datetime.datetime.now(datetime.timezone.utc):%Y%m%d_%H%M%S}.pdf"
    pdf_from_markdown(md_summary, pdf_path)

    await inter.user.send("📄 Meeting summary:", file=discord.File(pdf_path))
    session.__init__()

@bot.slash_command(description="Leave VC and reset")
async def leave(inter: discord.ApplicationContext):
    await inter.response.defer(ephemeral=True)
    if session.vc and session.vc.is_connected():
        await session.vc.disconnect()
    session.__init__()
    await inter.followup.send("👋 Left channel and cleared session.", ephemeral=True)

@bot.slash_command(description="Bot status")
async def status(inter: discord.ApplicationContext):
    await inter.respond(
        f"Status: **{'Recording' if session.active else 'Idle'}**, Chunks: {len(session.chunks)}",
        ephemeral=True
    )

@bot.slash_command(description="Transcribe & summarise an existing WAV")
async def process(
    inter: discord.ApplicationContext,
    filename: discord.Option(str, description="WAV file in /recordings")
):
    """
    Example:
      /process 20250712_171530.wav
    """
    await inter.response.defer(ephemeral=True)

    # Reject if a recording session is still running
    if session.active:
        return await inter.followup.send(
            "⚠️ Cannot process files while recording. Stop the session first.",
            ephemeral=True
        )

    # Validate filename & path
    wav_path = RECORD_DIR / filename
    if not wav_path.exists() or not wav_path.is_file() or wav_path.suffix.lower() != ".wav":
        return await inter.followup.send(
            f"❌ File `{filename}` not found in `{RECORD_DIR}/`.",
            ephemeral=True
        )

    await inter.followup.send("⏳ Processing file…", ephemeral=True)

    # ── pipeline ─────────────────────────────────────────
    transcript = transcribe(wav_path)
    md_summary = summarize(transcript)
    pdf_path   = SUMMARY_DIR / f"processed_{filename[:-4]}.pdf"
    pdf_from_markdown(md_summary, pdf_path)

    await inter.user.send(
        f"📄 Summary for `{filename}`:",
        file=discord.File(pdf_path)
    )
    await inter.followup.send("✅ Done! Check your DMs.", ephemeral=True)


@bot.event
async def on_ready():
    await bot.sync_commands()
    print(f"🤖 Logged in as {bot.user} — commands synced.")

bot.run(TOKEN)
