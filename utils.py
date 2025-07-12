import os, subprocess, tempfile
from pathlib import Path
from openai import OpenAI
from fpdf import FPDF
from dotenv import load_dotenv

load_dotenv()
client = OpenAI()

def combine_audio(wav_files: list[Path]) -> Path:
    if len(wav_files) == 1:
        return wav_files[0]
    txt = "\n".join(f"file '{p}'" for p in wav_files)
    flist = Path(tempfile.mktemp(suffix=".txt")); flist.write_text(txt)
    out = Path(tempfile.mktemp(suffix=".wav"))
    subprocess.run(
        ["ffmpeg", "-y", "-f", "concat", "-safe", "0",
         "-i", str(flist), "-c", "copy", str(out)],
        check=True
    )
    flist.unlink()
    return out

def transcribe(wav_path: Path) -> str:
    # First try the original file directly
    try:
        with open(wav_path, "rb") as f:
            return client.audio.transcriptions.create(
                model=os.getenv("MODEL_WHISPER","whisper-1"),
                file=f,
                response_format="text"
            )
    except Exception:
        # If that fails, try converting to MP3
        temp_path = Path(tempfile.mktemp(suffix=".mp3"))
        try:
            # Try more robust ffmpeg conversion
            subprocess.run([
                "ffmpeg", "-y", "-i", str(wav_path),
                "-f", "mp3", "-acodec", "libmp3lame", "-ar", "16000", "-ac", "1",
                "-b:a", "128k", str(temp_path)
            ], check=True, capture_output=True)
            
            with open(temp_path, "rb") as f:
                return client.audio.transcriptions.create(
                    model=os.getenv("MODEL_WHISPER","whisper-1"),
                    file=f,
                    response_format="text"
                )
        finally:
            temp_path.unlink(missing_ok=True)

SYSTEM_PROMPT = """You are an expert meeting summarizer and note-taker. Your job is to carefully review and distill the full transcript of a multi-person discussion, treating all dialogue as a single holistic conversation without attributing statements to specific speakers.

            You are not aware of individual speaker identities, so do not attempt to label or guess who said what. Instead, extract meaning from the flow of ideas and surface what matters most.

            Produce your output in GitHub-flavored Markdown using the following structure:

            ## Summary
            A concise but complete overview of what was discussed, including key themes, technical or strategic ideas, problems raised, and general tone of the conversation. Include enough detail for someone who didn't attend to understand what the meeting was about.

            ## Key Points
            - Bullet out notable ideas, facts, or discussion threads
            - Be specific, retain technical or nuanced phrasing if used
            - Group related points logically

            ## Decisions Made
            - List any decisions or conclusions reached (even informal ones)
            - If applicable, include supporting rationale briefly

            ## Action Items
            - List all tasks, who they apply to (if possible from context), and due dates (if mentioned)
            - Use bullet points with checkboxes, e.g. `- [ ] Draft follow-up report`

            ## Questions Raised
            - List any open questions, uncertainties, or things the group seemed unsure about
            - This helps guide follow-up discussion

            ## Suggestions / Next Steps
            - Add any implied or recommended next actions based on the conversation

            Use clear, readable language. Do not omit important details for the sake of brevity. Your output should serve as a polished, professional-grade meeting recap."""

def summarize(transcript: str) -> str:
    rsp = client.chat.completions.create(
        model=os.getenv("MODEL_SUMMARY","gpt-4.1-mini"),
        messages=[
            {"role":"system","content":SYSTEM_PROMPT},
            {"role":"user","content":transcript}
        ]
    )
    return rsp.choices[0].message.content

def pdf_from_markdown(md: str, output_path: Path) -> Path:
    """
    Render Markdown to PDF with proper formatting and layout.
    """
    pdf = FPDF()
    pdf.add_page()
    pdf.set_auto_page_break(auto=True, margin=15)
    pdf.set_margins(20, 20, 20)
    pdf.set_font("Arial", size=11)

    lines = md.splitlines()
    i = 0
    
    while i < len(lines):
        line = lines[i].rstrip()
        
        # Empty lines
        if not line:
            pdf.ln(4)
            i += 1
            continue
            
        # Headers
        if line.startswith("### "):
            pdf.set_font("Arial", "B", 12)
            pdf.ln(3)
            pdf.cell(0, 6, line[4:], 0, 1)
            pdf.ln(2)
            pdf.set_font("Arial", "", 11)
        elif line.startswith("## "):
            pdf.set_font("Arial", "B", 14)
            pdf.ln(4)
            pdf.cell(0, 7, line[3:], 0, 1)
            pdf.ln(3)
            pdf.set_font("Arial", "", 11)
        elif line.startswith("# "):
            pdf.set_font("Arial", "B", 16)
            pdf.ln(5)
            pdf.cell(0, 8, line[2:], 0, 1)
            pdf.ln(4)
            pdf.set_font("Arial", "", 11)
        # Bullet points
        elif line.startswith("- "):
            content = line[2:]
            # Handle checkbox items
            if content.startswith("[ ] "):
                pdf.cell(15, 5, "☐", 0, 0)
                pdf.multi_cell(0, 5, content[4:])
            elif content.startswith("[x] ") or content.startswith("[X] "):
                pdf.cell(15, 5, "☑", 0, 0)
                pdf.multi_cell(0, 5, content[4:])
            else:
                pdf.cell(15, 5, "•", 0, 0)
                pdf.multi_cell(0, 5, content)
            pdf.ln(1)
        # Code blocks
        elif line.startswith("```"):
            pdf.ln(2)
            pdf.set_font("Courier", "", 9)
            pdf.set_fill_color(245, 245, 245)
            i += 1
            code_lines = []
            while i < len(lines) and not lines[i].startswith("```"):
                code_lines.append(lines[i])
                i += 1
            
            for code_line in code_lines:
                pdf.cell(0, 4, code_line, 0, 1, fill=True)
            
            pdf.set_font("Arial", "", 11)
            pdf.ln(2)
        # Inline code
        elif "`" in line:
            parts = line.split("`")
            for j, part in enumerate(parts):
                if j % 2 == 0:  # Regular text
                    pdf.set_font("Arial", "", 11)
                    if part:
                        pdf.cell(pdf.get_string_width(part), 5, part, 0, 0)
                else:  # Code text
                    pdf.set_font("Courier", "", 10)
                    pdf.set_fill_color(240, 240, 240)
                    if part:
                        pdf.cell(pdf.get_string_width(part) + 2, 5, part, 0, 0, fill=True)
            pdf.ln(6)
            pdf.set_font("Arial", "", 11)
        # Bold text
        elif "**" in line:
            parts = line.split("**")
            for j, part in enumerate(parts):
                if j % 2 == 0:  # Regular text
                    pdf.set_font("Arial", "", 11)
                else:  # Bold text
                    pdf.set_font("Arial", "B", 11)
                if part:
                    if pdf.get_x() + pdf.get_string_width(part) > pdf.w - pdf.r_margin:
                        pdf.ln()
                    pdf.cell(pdf.get_string_width(part), 5, part, 0, 0)
            pdf.ln(6)
        # Regular paragraphs
        else:
            pdf.multi_cell(0, 5, line)
            pdf.ln(2)
        
        i += 1

    pdf.output(str(output_path))
    return output_path
