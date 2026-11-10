#!/usr/bin/env python3
"""
Reads the current version from project.pbxproj, determines the bump type from
the commit message using Conventional Commits, writes the new version back to
both project.pbxproj and manifest.json, and prints the new version string to
stdout for the workflow to capture.

Bump rules:
  BREAKING CHANGE in body, or type!: prefix   → major (x+1).0.0
  feat: / feature: / minor:                    → minor x.(y+1).0
  everything else                              → patch x.y.(z+1)
"""
import json
import re
import subprocess
import sys

PBXPROJ = "Image-Filter_Service.xcodeproj/project.pbxproj"
MANIFEST = "Shared/Extension/manifest.json"


def get_bump_type(commit_msg: str) -> str:
    first_line = commit_msg.split("\n")[0].strip()

    if "BREAKING CHANGE" in commit_msg:
        return "major"

    if re.match(r"^[a-zA-Z]+(\([^)]+\))?!:", first_line):
        return "major"

    m = re.match(r"^([a-zA-Z]+)(\([^)]+\))?:", first_line)
    if m:
        t = m.group(1).lower()
        if t == "major":
            return "major"
        if t in ("feat", "feature", "minor"):
            return "minor"
        return "patch"

    return "patch"


def version_tuple(v: str) -> tuple:
    return tuple(map(int, v.split(".")))


def latest_tag_version() -> str | None:
    try:
        result = subprocess.run(
            ["git", "tag", "-l", "v*", "--sort=-v:refname"],
            capture_output=True, text=True, check=True,
        )
        tags = [t.strip().lstrip("v") for t in result.stdout.splitlines() if t.strip()]
        return tags[0] if tags else None
    except Exception:
        return None


def bump(version: str, bump_type: str) -> str:
    major, minor, patch = map(int, version.split("."))
    if bump_type == "major":
        return f"{major + 1}.0.0"
    if bump_type == "minor":
        return f"{major}.{minor + 1}.0"
    return f"{major}.{minor}.{patch + 1}"


def main():
    commit_msg = sys.argv[1] if len(sys.argv) > 1 else ""

    # ── pbxproj ──────────────────────────────────────────────────────────────
    with open(PBXPROJ, "r") as f:
        pbx_content = f.read()

    current_version_match = re.search(r"MARKETING_VERSION = ([\d.]+)", pbx_content)
    if not current_version_match:
        print("ERROR: MARKETING_VERSION not found in pbxproj", file=sys.stderr)
        sys.exit(1)
    current_version = current_version_match.group(1)

    current_build_match = re.search(r"CURRENT_PROJECT_VERSION = (\d+)", pbx_content)
    if not current_build_match:
        print("ERROR: CURRENT_PROJECT_VERSION not found in pbxproj", file=sys.stderr)
        sys.exit(1)
    current_build = int(current_build_match.group(1))

    bump_type = get_bump_type(commit_msg)
    new_version = bump(current_version, bump_type)
    new_build = current_build + 1

    # If the computed version is already tagged (e.g. pbxproj wasn't updated after
    # the last workflow run), advance to the next patch so the tag is unique.
    latest = latest_tag_version()
    if latest and version_tuple(new_version) <= version_tuple(latest):
        new_version = bump(latest, "patch")
        print(
            f"::notice::Tag v{latest} already exists — advancing to {new_version}",
            file=sys.stderr,
        )

    pbx_content = re.sub(
        r"MARKETING_VERSION = [\d.]+",
        f"MARKETING_VERSION = {new_version}",
        pbx_content,
    )
    pbx_content = re.sub(
        r"CURRENT_PROJECT_VERSION = \d+",
        f"CURRENT_PROJECT_VERSION = {new_build}",
        pbx_content,
    )

    with open(PBXPROJ, "w") as f:
        f.write(pbx_content)

    # ── manifest.json ─────────────────────────────────────────────────────────
    with open(MANIFEST, "r") as f:
        manifest = json.load(f)

    manifest_old = manifest.get("version", "<unknown>")
    manifest["version"] = new_version

    with open(MANIFEST, "w") as f:
        json.dump(manifest, f, indent=4)
        f.write("\n")

    print(
        f"::notice::Version bump ({bump_type}): {current_version} → {new_version} "
        f"(build {new_build}); manifest.json {manifest_old} → {new_version}",
        file=sys.stderr,
    )
    # stdout is captured by the workflow to set GITHUB_OUTPUT
    print(f"new_version={new_version}")
    print(f"bump_type={bump_type}")
    print(f"new_build={new_build}")
    print(f"previous_version={current_version}")


if __name__ == "__main__":
    main()
