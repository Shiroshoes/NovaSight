"""
course_acronyms.py - program name -> acronym, used ONLY to make chart labels short.

Filters, drill-downs and API parameters keep using the full program name; the
dashboards look the acronym up for display (see courseShort() in maindash.js and
shortCourse() in prediction-dash.js, both fed from this table via /api/dash/meta
and /api/pred/meta).

Keys are upper-case with single spaces. Keep in sync with COURSE_ACRONYMS in
preprocess.py (that one feeds the Course_Acronym column).
"""
import re

COURSE_ACRONYMS = {
    "BACHELOR OF SCIENCE IN MIDWIFERY": "BSM",
    "BACHELOR OF SCIENCE IN PUBLIC HEALTH": "BSPH",
    "BACHELOR OF SCIENCE IN NURSING": "BSN",
    "BACHELOR OF SCIENCE IN TOURISM MANAGEMENT": "BSTM",
    "BACHELOR OF SCIENCE IN HOSPITALITY MANAGEMENT": "BSHM",
    "BACHELOR OF SCIENCE IN DATA SCIENCE": "BSDS",
    "BACHELOR OF SCIENCE IN ENTERTAINMENT AND MULTIMEDIA COMPUTING": "BSEMC",
    "BACHELOR OF SCIENCE IN COMPUTER SCIENCE": "BSCS",
    "BACHELOR OF SCIENCE IN INFORMATION TECHNOLOGY": "BSIT",
    "BACHELOR OF SCIENCE IN ELECTRICAL ENGINEERING": "BSEE",
    "BACHELOR OF SCIENCE IN COMPUTER ENGINEERING": "BSCpE",
    "BACHELOR OF SCIENCE IN ARCHITECTURE": "BS Arch",
    "BACHELOR OF SCIENCE IN ELECTRONICS ENGINEERING": "BSECE",
    "BACHELOR OF SCIENCE IN CIVIL ENGINEERING": "BSCE",
    "BACHELOR OF SCIENCE IN INDUSTRIAL ENGINEERING": "BSIE",
    "BACHELOR OF SCIENCE IN MECHANICAL ENGINEERING": "BSME",
    "BACHELOR OF SCIENCE IN RAILWAY ENGINEERING": "BSRE",
    "BACHELOR OF ARTS IN COMMUNICATION": "BA Comm",
    "BACHELOR OF SCIENCE IN DEVELOPMENT COMMUNICATION": "BS DevComm",
    "BACHELOR OF TECHNICAL-VOCATIONAL TEACHER EDUCATION": "BTVTED",
    "BACHELOR OF SCIENCE IN INDUSTRIAL TECHNOLOGY": "BS IndTech",
}


def _key(name) -> str:
    s = str(name or "").strip().upper().replace("–", "-").replace("—", "-")
    return re.sub(r"\s+", " ", s)


def course_short(name):
    """Acronym for a program name, or the name itself when it isn't on the list
    (so an unknown course still shows up on the chart, just not shortened)."""
    if name is None:
        return name
    return COURSE_ACRONYMS.get(_key(name), name)