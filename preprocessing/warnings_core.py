"""
warnings_core.py
=================
Shared "warning modal" infrastructure used by BOTH preprocess_v2.py
(grade-file cleaning) and course_catalog_checker.py (course-code
baseline file cleaning). Lives in its own module so neither of those
two files has to import the other (avoids a circular import).

Three priority tiers — always shown in this order, top to bottom:

  🔴 NULL      — a required field is empty or missing.
  🟡 HIGHLIGHT — a value fell OUTSIDE every rule the script knows how
                 to interpret or auto-correct (unrecognized text,
                 unknown course code not in the catalog, an out-of-
                 pattern value, etc).

                 IMPORTANT: being highlighted here does NOT mean the
                 row gets deleted or excluded. Falling outside the
                 defined processing rules is not, by itself, a reason
                 to auto-remove anything — it just means a human
                 should look at it before the upload is accepted. The
                 row (and the original raw value) stays in the full
                 output either way.

     (plain)   — everything else: typo auto-corrections, resolved
                 slash-grades, duplicate-handling notes, credit-unit
                 mismatches, etc. Still worth reviewing, just lower
                 urgency than the two tiers above.
"""

from __future__ import annotations
from dataclasses import dataclass, field


# Missing required identity/metadata fields — grade file AND catalog file.
NULL_WARNING_CATEGORIES = {
    "Null Course",
    "Null Course Code",
    "Null Subject",
    "Null Credit Units",
    "Null Credits Earned",
    "Null Seq",
    "Null Course Code (Catalog)",
    "Null Course Title (Catalog)",
    "Null Credit Units (Catalog)",
    "Conflicting Catalog Entry",
    "Subject Count mismatch",
}

# Values that fell OUTSIDE every rule the script knows how to
# interpret/auto-correct. See the module docstring above — highlighted,
# never silently auto-deleted.
HIGHLIGHT_CATEGORIES = {
    "Hindi kilalang Gender",
    "Hindi kilalang College",
    "Hindi kilalang Year Level",
    "Hindi kilalang Academic Year",
    "Hindi kilalang Semester",
    "Invalid grade text",
    "Unknown Course Code (not in catalog)",
    "Di-karaniwang grade value",
    # A grade sitting in a column with no subject code above it. The
    # script cannot tell which subject it belongs to, so it falls
    # outside every rule — highlighted for a human, never deleted.
    "Orphan grade (walang code)",
}


@dataclass
class WarningCollector:
    """
    Every rule that says "warning sa modal" adds an entry here instead
    of a real UI. print_modal() renders it the way the eventual web
    modal would; confirm() (in preprocess_v2.py) is the eventual
    "Proceed anyway?" button, done via console input for now.
    """
    items: list = field(default_factory=list)

    def add(self, category: str, message: str, ref: str | None = None):
        self.items.append({"category": category, "message": message, "ref": ref})

    def _tier(self, category: str) -> int:
        if category in NULL_WARNING_CATEGORIES:
            return 0
        if category in HIGHLIGHT_CATEGORIES:
            return 1
        return 2  # resolved / plain

    def sorted_items(self):
        return sorted(self.items, key=lambda it: self._tier(it["category"]))  # stable sort

    def count_by_category(self):
        out = {}
        for it in self.sorted_items():
            out[it["category"]] = out.get(it["category"], 0) + 1
        return out

    def _marker(self, category: str) -> str:
        tier = self._tier(category)
        return "🔴 " if tier == 0 else ("🟡 " if tier == 1 else "✅ ")

    def print_modal(self, max_detail: int = 60):
        if not self.items:
            print("\n✅ No warnings — file looks clean.")
            return
        ordered = self.sorted_items()
        print(f"\n⚠️  {len(ordered)} warning(s) found — review before confirming upload:\n")
        for cat, n in self.count_by_category().items():
            print(f"   • {self._marker(cat)}{cat}: {n}")
        print(
            "\n   Detail (🔴 Null shown first, then 🟡 Highlight/outside-process,"
            " then ✅ Resolved — auto-corrections and handled cases):"
        )
        for it in ordered[:max_detail]:
            ref = f" [{it['ref']}]" if it["ref"] else ""
            print(f"     {self._marker(it['category'])}({it['category']}){ref} {it['message']}")
        if len(ordered) > max_detail:
            print(f"     ... at {len(ordered) - max_detail} pa.")
        print(
            "\n   Note: 🟡 Highlight items are 'outside known processing rules' — "
            "they are NOT automatically removed from the dataset. "
            "They remain in the full output, highlighted for human review.\n"
            "   ✅ Resolved items are auto-corrections and handled cases (e.g. grade snapped, "
            "slash resolved, typo corrected) — informational only."
        )