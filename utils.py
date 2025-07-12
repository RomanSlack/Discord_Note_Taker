import os, subprocess, tempfile, uuid
from pathlib import Path
from openai import OpenAI
from fpdf import FPDF
from dotenv import load_dotenv

load_dotenv()
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
            {"role": "system", "content": """You are an expert meeting summarizer and note-taker. Your job is to carefully review and distill the full transcript of a multi-person discussion, treating all dialogue as a single holistic conversation without attributing statements to specific speakers.

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

            Use clear, readable language. Do not omit important details for the sake of brevity. Your output should serve as a polished, professional-grade meeting recap."""},

            {"role": "user", "content": transcript}
        ]
    )
    return rsp.choices[0].message.content

def pdf_from_markdown(md: str, output_path: Path = None) -> Path:
    """Render summary Markdown to a PDF with proper formatting."""
    pdf = FPDF()
    pdf.add_page()
    pdf.set_auto_page_break(auto=True, margin=15)
    pdf.set_margins(20, 20, 20)

    for line in md.splitlines():
        line = line.strip()
        if not line:
            pdf.ln(4)
            continue
        
        # Handle different markdown elements
        if line.startswith('# '):
            # Header 1
            pdf.set_font("Arial", "B", 16)
            pdf.ln(2)
            pdf.cell(0, 8, line[2:], ln=True)
            pdf.ln(2)
        elif line.startswith('## '):
            # Header 2
            pdf.set_font("Arial", "B", 14)
            pdf.ln(2)
            pdf.cell(0, 7, line[3:], ln=True)
            pdf.ln(1)
        elif line.startswith('### '):
            # Header 3
            pdf.set_font("Arial", "B", 12)
            pdf.ln(1)
            pdf.cell(0, 6, line[4:], ln=True)
        elif line.startswith('- ') or line.startswith('* '):
            # Bullet points
            pdf.set_font("Arial", "", 10)
            bullet_text = line[2:]
            pdf.cell(10, 5, "•", ln=False)
            
            # Handle long bullet points
            if len(bullet_text) > 70:
                words = bullet_text.split()
                current_line = ""
                for word in words:
                    if len(current_line + word) < 70:
                        current_line += word + " "
                    else:
                        pdf.cell(0, 5, current_line.strip(), ln=True)
                        pdf.cell(10, 5, "", ln=False)  # indent
                        current_line = word + " "
                if current_line:
                    pdf.cell(0, 5, current_line.strip(), ln=True)
            else:
                pdf.cell(0, 5, bullet_text, ln=True)
        else:
            # Regular text
            pdf.set_font("Arial", "", 10)
            
            # Handle long lines by wrapping
            if len(line) > 80:
                words = line.split()
                current_line = ""
                for word in words:
                    if len(current_line + word) < 80:
                        current_line += word + " "
                    else:
                        pdf.cell(0, 5, current_line.strip(), ln=True)
                        current_line = word + " "
                if current_line:
                    pdf.cell(0, 5, current_line.strip(), ln=True)
            else:
                pdf.cell(0, 5, line, ln=True)

    if output_path is None:
        output_path = Path(tempfile.mktemp(suffix=".pdf"))
    pdf.output(output_path)
    return output_path
