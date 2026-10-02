# -*- coding: utf-8 -*-
"""Convert Infotexte3.docx + Bildbeschreibungen.docx into app texts/config/images."""
import json
import re
import zipfile
import xml.etree.ElementTree as ET
from io import BytesIO
from pathlib import Path

from PIL import Image

W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
A = "{http://schemas.openxmlformats.org/drawingml/2006/main}"
R = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
EMOJI_HEAD = re.compile(r"^[\U0001F300-\U0001FAFF\u2600-\u27BF\u2300-\u23FF\uFE0F\u200D]")
CHECK = re.compile(r"[\u2705\u2713\u2714\u2611]\uFE0F?")


def is_on(el):
    if el is None:
        return False
    return el.attrib.get(f"{W}val", "true") not in ("0", "false", "off")


def run_flags_text(run):
    text = "".join(t.text or "" for t in run.findall(f"{W}t"))
    if text == "":
        return None
    rpr = run.find(f"{W}rPr")
    bold = is_on(rpr.find(f"{W}b")) if rpr is not None else False
    italic = is_on(rpr.find(f"{W}i")) if rpr is not None else False
    return bold, italic, text


def wrap_md(text, bold, italic):
    if not text:
        return ""
    leading = re.match(r"^\s*", text).group(0)
    trailing = re.search(r"\s*$", text).group(0)
    core = text[len(leading) : len(text) - len(trailing) if trailing else len(text)]
    if not core:
        return text
    if bold and italic:
        core = f"***{core}***"
    elif bold:
        core = f"**{core}**"
    elif italic:
        core = f"*{core}*"
    return f"{leading}{core}{trailing}"


def para_md(para):
    chunks = []
    for child in list(para):
        if child.tag == f"{W}r":
            runs = [child]
        elif child.tag == f"{W}hyperlink":
            runs = child.findall(f"{W}r")
        else:
            continue
        for run in runs:
            info = run_flags_text(run)
            if info is None:
                continue
            bold, italic, text = info
            if chunks and chunks[-1][:2] == (bold, italic):
                chunks[-1] = (bold, italic, chunks[-1][2] + text)
            else:
                chunks.append((bold, italic, text))
    return "".join(wrap_md(t, b, i) for b, i, t in chunks).strip()


def style_of(para):
    st = para.find(f"{W}pPr/{W}pStyle")
    return st.attrib.get(f"{W}val", "") if st is not None else ""


def plain_of(para):
    return "".join(t.text or "" for t in para.findall(f".//{W}t")).strip()


def embeds(para, rels):
    out = []
    for blip in para.findall(f".//{A}blip"):
        embed = blip.attrib.get(f"{R}embed")
        if not embed or embed not in rels:
            continue
        t = rels[embed].replace("\\", "/")
        if t.startswith("/"):
            t = t[1:]
        if not t.startswith("media/"):
            t = "media/" + Path(t).name
        out.append(t)
    return out


def parse_bildbeschreibungen(path):
    with zipfile.ZipFile(path) as z:
        root = ET.fromstring(z.read("word/document.xml"))
        lines = []
        for para in root.findall(f".//{W}body/{W}p"):
            plain = plain_of(para)
            md = para_md(para)
            if plain:
                lines.append((plain, md))
    captions = []
    i = 0
    while i < len(lines):
        plain, _md = lines[i]
        looks_name = bool(
            re.search(r"\.(png|jpe?g|webp)$", plain, re.I)
            or "unsplash" in plain.lower()
            or "Staphylococcus_" in plain
            or plain.startswith("MRSA")
            or plain.startswith("Phage")
            or plain.startswith("Lugdunin")
            or plain.startswith("Infektionsforschung")
            or plain.startswith("christina")
        )
        if looks_name and i + 1 < len(lines):
            captions.append(lines[i + 1][1])
            i += 2
        else:
            i += 1
    return captions


def parse_quiz(lines):
    quiz = []
    q = None
    for raw in lines:
        has_check = bool(CHECK.search(raw) or "✅" in raw)
        line = CHECK.sub("", raw).replace("✅", "").strip()
        m = re.match(r"^\d+\.\s*(.+)$", line)
        if m:
            if q:
                quiz.append(q)
            q = {"question": m.group(1).strip(), "options": [], "correct": 0}
            continue
        om = re.match(r"^([A-D])\)\s*(.+)$", line)
        if om and q is not None:
            opt = om.group(2).strip()
            if has_check:
                q["correct"] = len(q["options"])
            q["options"].append(opt)
    if q:
        quiz.append(q)
    return quiz


def blocks_to_text(title_plain, blocks):
    lines = [title_plain, ""]
    for kind, md, _plain in blocks:
        if kind == "h2":
            lines.append(md if "*" in md else _plain)
        elif kind == "li":
            lines.append(f"- {md}")
        else:
            lines.append(md)
    while lines and not lines[-1].strip():
        lines.pop()
    return "\n".join(lines) + "\n"


def main():
    root = Path(__file__).resolve().parent
    captions = parse_bildbeschreibungen(root / "Assets/Texts/Bildbeschreibungen.docx")
    print("captions:", len(captions))
    for c in captions:
        print(" -", c[:90])

    docx = root / "Assets/Texts/Infotexte3.docx"
    with zipfile.ZipFile(docx) as z:
        rels = {
            e.attrib["Id"]: e.attrib["Target"].replace("\\", "/")
            for e in ET.fromstring(z.read("word/_rels/document.xml.rels"))
        }
        body = ET.fromstring(z.read("word/document.xml"))
        media_bytes = {n: z.read(n) for n in z.namelist() if n.startswith("word/media/")}
        paras = []
        for para in body.findall(f".//{W}body/{W}p"):
            paras.append(
                {
                    "md": para_md(para),
                    "plain": plain_of(para),
                    "style": style_of(para),
                    "images": embeds(para, rels),
                }
            )

    topics = []
    current = None
    for p in paras:
        if p["style"] == "berschrift1":
            if current:
                topics.append(current)
            current = {
                "title_md": p["md"],
                "title_plain": re.sub(r"^\d+\.\s*", "", p["plain"]).strip(),
                "blocks": [],
                "images": list(p["images"]),
                "captions": [],
                "quiz": [],
                "source": "",
            }
            continue
        if current is None:
            continue
        if p["images"]:
            current["images"].extend(p["images"])
            continue
        plain = p["plain"]
        md = p["md"]
        if not plain:
            continue
        if re.match(r"^Quellen\s*:", plain, re.I):
            current["source"] = plain
            continue
        if re.match(r"^Kleines Quiz", plain, re.I):
            current["_in_quiz"] = True
            continue
        if current.get("_in_quiz"):
            current["quiz"].append(plain)
            continue
        if re.search(r"\b(?:Bild|Foto|Visualisierung|Darstellung)\s*:", plain, re.I) and not EMOJI_HEAD.match(plain):
            current["captions"].append(md)
            continue
        if EMOJI_HEAD.match(plain):
            kind = "h2"
        elif p["style"] in ("Aufzhlungszeichen", "berschrift2"):
            kind = "li"
        else:
            kind = "p"
        current["blocks"].append((kind, md, plain))
    if current:
        topics.append(current)

    id_map = [
        ("gutes_bakterium", "gutes_bakterium.glb", "gutes_bakterium"),
        ("krankheitserreger", "krankheitserreger.glb", "krankheitserreger"),
        ("mrsa", "mrsa.glb", "mrsa"),
        ("lugdunin", "lugdunin.glb", "lugdunin"),
        ("phage", "phage.glb", "phage"),
        ("antibiotikum", "antibiotikum.glb", "antibiotikum"),
    ]
    image_plan = {
        "gutes_bakterium": [("media/image1.png", "gutes_bakterium.webp", "Mikroskopische Aufnahme kugelförmiger Staphylokokken")],
        "krankheitserreger": [("media/image2.jpeg", "krankheitserreger.webp", "Kolonie von Staphylococcus aureus auf Blutagar")],
        "mrsa": [("media/image3.jpeg", "mrsa.webp", "MRSA-Bakterien und weißes Blutkörperchen")],
        "lugdunin": [
            ("media/image4.png", "lugdunin_molekuel.webp", "Molekülstruktur von Lugdunin"),
            ("media/image5.jpeg", "lugdunin_nase.webp", "Kampf im Nasenmikrobiom"),
        ],
        "phage": [
            ("media/image6.jpeg", "phage_infektion.webp", "Bakteriophagen infizieren eine Staphylokokken-Zelle"),
            ("media/image7.jpeg", "phage_k3.webp", "Bakteriophage K3"),
        ],
        "antibiotikum": [("media/image8.jpg", "antibiotikum.webp", "Antibiotikakapseln")],
    }

    img_dir = root / "Assets/Images"
    for topic_imgs in image_plan.values():
        for media_path, webp_name, _alt in topic_imgs:
            data = media_bytes["word/" + media_path]
            with Image.open(BytesIO(data)) as im:
                if im.mode not in ("RGB", "RGBA"):
                    im = im.convert("RGB")
                im.thumbnail((1600, 1600), Image.Resampling.LANCZOS)
                target = img_dir / webp_name
                im.save(target, "WEBP", quality=88, method=6)
                print("image", target.name, im.size)

    # captions from Bildbeschreibungen in document order
    caption_iter = iter(captions)
    config = {"Inhalte": {}}
    text_dir = root / "Assets/Texts"

    for idx, topic in enumerate(topics):
        if idx >= len(id_map):
            break
        tid, model, qr = id_map[idx]
        plan = image_plan[tid]
        images = []
        for _media, webp_name, alt in plan:
            caption = next(caption_iter, topic["captions"][len(images)] if len(topic["captions"]) > len(images) else "")
            images.append({"file": webp_name, "alt": alt, "caption": caption})
        quiz = parse_quiz(topic["quiz"])
        text_body = blocks_to_text(topic["title_plain"], topic["blocks"])
        quiz_lines = ["Kleines Quiz"]
        for qi, item in enumerate(quiz, 1):
            quiz_lines.append(f"{qi}. {item['question']}")
            for oi, opt in enumerate(item["options"]):
                mark = " ✅" if oi == item["correct"] else ""
                quiz_lines.append(f"{chr(65 + oi)}) {opt}{mark}")
        full = text_body.rstrip() + "\n" + "\n".join(quiz_lines)
        if topic["source"]:
            full += "\n" + topic["source"]
        full += "\n"
        (text_dir / f"{tid}.txt").write_text(full, encoding="utf-8")
        entry = {
            "qrText": qr,
            "name": topic["title_plain"],
            "model": model,
            "text": f"{tid}.txt",
            "images": images,
            "quiz": quiz,
        }
        if topic["source"]:
            entry["source"] = topic["source"]
        config["Inhalte"][tid] = entry
        print("topic", tid, "quiz", len(quiz), "images", len(images), "corrects", [q["correct"] for q in quiz])

    (root / "config.json").write_text(json.dumps(config, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("done")


if __name__ == "__main__":
    main()
