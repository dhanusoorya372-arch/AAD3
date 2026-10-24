import csv
import hashlib
import io
import json
import os
import re
import threading
import uuid
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

from flask import Flask, jsonify, make_response, render_template, request
from werkzeug.utils import secure_filename


BASE_DIR = Path(__file__).resolve().parent
UPLOAD_DIR = BASE_DIR / "uploads"
MANIFEST_PATH = UPLOAD_DIR / "manifest.json"
CHUNK_SIZE = 1024 * 1024
FILE_ID_PATTERN = re.compile(r"^[a-f0-9]{32}$")
manifest_lock = threading.RLock()


def configured_upload_limit():
    """Read the request-size limit from the environment, defaulting to 100 MB."""
    try:
        limit_mb = int(os.environ.get("MAX_UPLOAD_MB", "100"))
    except ValueError as error:
        raise RuntimeError("MAX_UPLOAD_MB must be a positive whole number.") from error

    if limit_mb < 1:
        raise RuntimeError("MAX_UPLOAD_MB must be at least 1.")
    return limit_mb * 1024 * 1024


app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = configured_upload_limit()
app.config["MAX_UPLOAD_MB"] = app.config["MAX_CONTENT_LENGTH"] // (1024 * 1024)
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)


def read_manifest():
    """Load uploaded-file metadata, raising an error if its JSON is corrupted."""
    if not MANIFEST_PATH.exists():
        return []

    try:
        with MANIFEST_PATH.open("r", encoding="utf-8") as manifest_file:
            records = json.load(manifest_file)
    except (OSError, json.JSONDecodeError) as error:
        raise RuntimeError(f"Could not read the upload manifest: {error}") from error

    if not isinstance(records, list):
        raise RuntimeError("The upload manifest has an invalid format.")
    return records


def write_manifest(records):
    """Write metadata atomically so interrupted writes do not corrupt the manifest."""
    temporary_path = UPLOAD_DIR / f".manifest-{uuid.uuid4().hex}.tmp"
    try:
        with temporary_path.open("w", encoding="utf-8") as manifest_file:
            json.dump(records, manifest_file, indent=2)
        temporary_path.replace(MANIFEST_PATH)
    finally:
        if temporary_path.exists():
            temporary_path.unlink()


def build_results(records):
    """Group files by exact SHA-256 content and calculate non-duplicated savings."""
    by_hash = defaultdict(list)
    for record in sorted(records, key=lambda item: (item["uploaded_at"], item["id"])):
        by_hash[record["sha256"]].append(record)

    groups = []
    files = []
    total_savings = 0
    duplicate_file_count = 0

    for file_hash, members in by_hash.items():
        keeper_id = members[0]["id"]
        count = len(members)
        size = members[0]["size"]
        savings = size * (count - 1)
        total_savings += savings
        duplicate_file_count += count - 1

        group_files = []
        for member in members:
            decorated = {
                **member,
                "is_duplicate_copy": member["id"] != keeper_id,
                "duplicate_count": count - 1,
            }
            group_files.append(decorated)
            files.append(decorated)

        if count > 1:
            groups.append(
                {
                    "sha256": file_hash,
                    "size": size,
                    "count": count,
                    "duplicate_count": count - 1,
                    "savings": savings,
                    "files": group_files,
                }
            )

    files.sort(key=lambda item: (item["uploaded_at"], item["name"].casefold()))
    groups.sort(key=lambda item: item["files"][0]["name"].casefold())
    return {
        "files": files,
        "groups": groups,
        "stats": {
            "total_files": len(records),
            "unique_files": len(by_hash),
            "duplicate_files": duplicate_file_count,
            "storage_savings": total_savings,
        },
    }


def error_response(message, status_code):
    return jsonify({"error": message}), status_code


@app.get("/")
def index():
    return render_template(
        "index.html", max_upload_mb=app.config["MAX_UPLOAD_MB"]
    )


@app.post("/api/upload")
def upload_files():
    incoming_files = [
        uploaded_file
        for uploaded_file in request.files.getlist("files")
        if uploaded_file and uploaded_file.filename
    ]
    if not incoming_files:
        return error_response("Choose at least one file before uploading.", 400)

    new_records = []
    saved_paths = []
    try:
        for uploaded_file in incoming_files:
            display_name = secure_filename(Path(uploaded_file.filename).name)
            if not display_name:
                display_name = "uploaded-file"

            file_id = uuid.uuid4().hex
            destination = UPLOAD_DIR / file_id
            content_hash = hashlib.sha256()
            file_size = 0

            with destination.open("xb") as destination_file:
                saved_paths.append(destination)
                while True:
                    chunk = uploaded_file.stream.read(CHUNK_SIZE)
                    if not chunk:
                        break
                    destination_file.write(chunk)
                    content_hash.update(chunk)
                    file_size += len(chunk)

            new_records.append(
                {
                    "id": file_id,
                    "name": display_name,
                    "size": file_size,
                    "sha256": content_hash.hexdigest(),
                    "uploaded_at": datetime.now(timezone.utc).isoformat(),
                }
            )

        with manifest_lock:
            records = read_manifest()
            records.extend(new_records)
            write_manifest(records)
    except (OSError, RuntimeError) as error:
        for saved_path in saved_paths:
            try:
                saved_path.unlink(missing_ok=True)
            except OSError:
                app.logger.exception("Could not clean up an incomplete upload.")
        app.logger.exception("File upload failed.")
        return error_response(f"Upload could not be completed: {error}", 500)

    return jsonify(
        {
            "message": f"Uploaded {len(new_records)} file(s) and scanned their contents.",
            **build_results(records),
        }
    ), 201


@app.get("/api/results")
def get_results():
    try:
        with manifest_lock:
            results = build_results(read_manifest())
    except RuntimeError as error:
        app.logger.exception("Could not load scan results.")
        return error_response(str(error), 500)
    return jsonify(results)


@app.get("/api/report.csv")
def download_report():
    try:
        with manifest_lock:
            results = build_results(read_manifest())
    except RuntimeError as error:
        app.logger.exception("Could not create the CSV report.")
        return error_response(str(error), 500)

    output = io.StringIO(newline="")
    writer = csv.writer(output)
    writer.writerow(
        [
            "Filename",
            "Size (bytes)",
            "SHA-256",
            "Group file count",
            "Duplicate copy",
            "Uploaded at (UTC)",
        ]
    )

    for uploaded_file in results["files"]:
        # Prefix formula-like values so CSV viewers do not execute user filenames.
        filename = uploaded_file["name"]
        if filename.startswith(("=", "+", "-", "@", "\t", "\r")):
            filename = "'" + filename
        writer.writerow(
            [
                filename,
                uploaded_file["size"],
                uploaded_file["sha256"],
                uploaded_file["duplicate_count"] + 1,
                "Yes" if uploaded_file["is_duplicate_copy"] else "No",
                uploaded_file["uploaded_at"],
            ]
        )

    response = make_response("\ufeff" + output.getvalue())
    response.headers["Content-Type"] = "text/csv; charset=utf-8"
    response.headers["Content-Disposition"] = (
        'attachment; filename="duplicate-detection-report.csv"'
    )
    return response


@app.delete("/api/files")
def delete_duplicate_copies():
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict) or not isinstance(payload.get("file_ids"), list):
        return error_response("Provide a list of uploaded file IDs to remove.", 400)

    requested_ids = payload["file_ids"]
    if not requested_ids or any(not isinstance(item, str) for item in requested_ids):
        return error_response("Select at least one duplicate copy to remove.", 400)
    if len(set(requested_ids)) != len(requested_ids):
        return error_response("The selection contains duplicate file IDs.", 400)
    if any(not FILE_ID_PATTERN.fullmatch(item) for item in requested_ids):
        return error_response("The selection contains an invalid file ID.", 400)

    try:
        with manifest_lock:
            records = read_manifest()
            current = build_results(records)
            files_by_id = {item["id"]: item for item in current["files"]}

            missing_ids = [item for item in requested_ids if item not in files_by_id]
            if missing_ids:
                return error_response(
                    "One or more selected uploads no longer exist. Refresh and try again.",
                    404,
                )

            non_duplicates = [
                item
                for item in requested_ids
                if not files_by_id[item]["is_duplicate_copy"]
            ]
            if non_duplicates:
                return error_response(
                    "Only marked duplicate copies can be removed.", 400
                )

            selected_paths = [UPLOAD_DIR / item for item in requested_ids]
            for selected_path in selected_paths:
                if not selected_path.is_file():
                    return error_response(
                        "An uploaded copy is missing from server storage. Refresh the results.",
                        404,
                    )

            selected_set = set(requested_ids)
            remaining_records = [
                record for record in records if record["id"] not in selected_set
            ]
            removed_ids = []
            for selected_path, file_id in zip(selected_paths, requested_ids):
                try:
                    selected_path.unlink()
                except OSError as error:
                    records = [
                        record
                        for record in records
                        if record["id"] not in set(removed_ids)
                    ]
                    write_manifest(records)
                    app.logger.exception("Could not remove an uploaded duplicate.")
                    return error_response(
                        f"Could not remove every selected copy: {error}", 500
                    )
                removed_ids.append(file_id)

            write_manifest(remaining_records)
    except RuntimeError as error:
        app.logger.exception("Could not update uploaded-file metadata.")
        return error_response(str(error), 500)
    except OSError as error:
        app.logger.exception("Could not update uploaded-file metadata.")
        return error_response(f"Could not update scan results: {error}", 500)

    return jsonify(
        {
            "message": f"Removed {len(requested_ids)} uploaded duplicate copy/copies.",
            **build_results(remaining_records),
        }
    )


@app.errorhandler(413)
def request_too_large(_error):
    return error_response(
        f"The selected upload exceeds the {app.config['MAX_UPLOAD_MB']} MB request limit.",
        413,
    )


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000, debug=False)
