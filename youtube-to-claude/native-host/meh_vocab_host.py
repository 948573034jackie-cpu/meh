#!/usr/bin/python3
"""The small helper on the Mac: Chrome hands it the vocabulary database (Chrome's "native messaging"), it writes
~/Documents/MEH English/vocabulary.json and the copy in Google Drive. A Chrome extension cannot write these files
itself. It only ever writes those two files. The helper reads one message and answers it; Chrome starts it each time."""
import glob
import json
import os
import struct
import sys
import tempfile

FOLDER = 'MEH English'
NAME = 'vocabulary.json'


def home():
    return os.environ.get('MEH_HOME') or os.path.expanduser('~')


def drive_folder():
    """My Drive of Google Drive for desktop, or None when it is not installed / not signed in."""
    h = home()
    found = sorted(glob.glob(os.path.join(h, 'Library/CloudStorage/GoogleDrive-*/My Drive'))) \
        + sorted(glob.glob(os.path.join(h, 'Library/CloudStorage/GoogleDrive-*/我的云端硬盘')))
    if found:
        return found[0]
    old = os.path.join(h, 'Google Drive/My Drive')
    return old if os.path.isdir(old) else None


def write_atomic(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), prefix='.vocabulary-')
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            f.write(text)
        os.replace(tmp, path)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise


def handle(msg):
    kind = msg.get('type')
    main = os.path.join(home(), 'Documents', FOLDER, NAME)
    drive = drive_folder()
    copy = os.path.join(drive, FOLDER, NAME) if drive else None
    if kind == 'ping':
        return {'ok': True, 'path': main, 'drive': copy}
    if kind != 'write' or not isinstance(msg.get('doc'), dict):
        return {'ok': False, 'error': 'unknown message'}
    text = json.dumps(msg['doc'], ensure_ascii=False, indent=2) + '\n'
    write_atomic(main, text)
    out = {'ok': True, 'path': main, 'drive': copy, 'driveOk': False}
    if copy:
        try:
            write_atomic(copy, text)
            out['driveOk'] = True
        except OSError as e:
            out['driveError'] = str(e)
    else:
        out['driveError'] = 'Google Drive for desktop was not found on this Mac'
    return out


def main():
    head = sys.stdin.buffer.read(4)
    if len(head) < 4:
        return
    size = struct.unpack('=I', head)[0]
    try:
        reply = handle(json.loads(sys.stdin.buffer.read(size).decode('utf-8')))
    except Exception as e:  # the extension shows it: nothing is lost, it writes again on the next change
        reply = {'ok': False, 'error': str(e)}
    data = json.dumps(reply).encode('utf-8')
    sys.stdout.buffer.write(struct.pack('=I', len(data)) + data)
    sys.stdout.buffer.flush()


if __name__ == '__main__':
    main()
