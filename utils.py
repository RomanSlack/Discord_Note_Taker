import os, subprocess, tempfile, uuid
from pathlib import Path
from openai import OpenAI
from fpdf import FPDF

client = OpenAI()

def combine_audio(wav_files: list[Path]) -> Path:
    """Concatenate WAV chunks losslessly using ffmpeg."""
    if len(wav_files) == 1:
        return wav_files[0]
    txt = "\n".join(f"file '{p.as_posix()}'" for p in wav_files)
    flist = Path(tempfile.mktemp(suffix=".txt"))
    flist.write_text(txt)
    out_path = Path(tempfile.mktemp(suffix=".wav"))
    subprocess.run(["ffmpeg", "-y", "-f", "concat", "-safe", "0",
                    "-i", flist, "-c", "copy", out_path], check=True)
    flist.unlink()
    return out_path

def transcribe(wav_path: Path) -> str:
    """Send audio to Whisper via OpenAI Audio → text."""
    with open(wav_path, "rb") as f:
        rsp = client.audio.transcriptions.create(
            model=os.getenv("MODEL_WHISPER", "whisper-1"),
            file=f,
            response_format="text"
        )
    return rsp

def summarize(transcript: str) -> str:
    """Ask GPT-4.1-mini for a Markdown meeting summary."""
    rsp = client.chat.completions.create(
        model=os.getenv("MODEL_SUMMARY", "gpt-4.1-mini"),
        messages=[
            {"role": "system", "content": "You are a concise meeting summarizer. Reply in GitHub-flavored Markdown with sections: Summary, Decisions, Action Items."},
            {"role": "user", "content": transcript}
        ]
    )
    return rsp.choices[0].message.content

def pdf_from_markdown(md: str) -> Path:
    """Render summary Markdown to a simple PDF."""
    pdf = FPDF()
    pdf.add_page()
    pdf.set_font("Helvetica", size=11)
    for line in md.splitlines():
        pdf.multi_cell(0, 7, line)
    out = Path(tempfile.mktemp(suffix=".pdf"))
    pdf.output(out)
    return out
