#!/usr/bin/env python3
import argparse
import os
import socket
import subprocess
import sys
import time


def is_server_running(port=10000):
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    result = sock.connect_ex(('127.0.0.1', port))
    sock.close()
    return result == 0


parser = argparse.ArgumentParser(add_help=False)
parser.add_argument('--venv',       default=None, help='Path to virtualenv root')
parser.add_argument('--server-dir', default=None, help='Path to directory containing app.py')
parser.add_argument('--log-dir',    default=None, help='Directory for server.log / server_error.log')
parser.add_argument('--pid-file',   default=None, help='Path for gunicorn PID file')
args, _ = parser.parse_known_args()

script_dir = os.path.dirname(os.path.abspath(__file__))   # server/
server_dir = os.path.abspath(args.server_dir) if args.server_dir else script_dir
venv_root  = os.path.abspath(args.venv)       if args.venv       else os.path.join(os.path.dirname(script_dir), '.venv')
venv_bin   = os.path.join(venv_root, 'bin')
log_dir    = os.path.abspath(args.log_dir)    if args.log_dir    else server_dir
pid_file   = os.path.abspath(args.pid_file)   if args.pid_file   else os.path.join(server_dir, 'gunicorn.pid')

if is_server_running():
    print("Server is already running on port 10000")
    sys.exit(0)

os.makedirs(log_dir, exist_ok=True)
os.chdir(server_dir)

env = os.environ.copy()
env['PATH'] = venv_bin + ':' + env.get('PATH', '')
env['VIRTUAL_ENV'] = venv_root
# Keep Python's bytecode cache OUT of the app bundle. After the app has updated itself the bundle belongs
# to the user, so Python could write Contents/Resources/server/__pycache__ into it and break the app's
# code signature ("file added"). With a cache prefix the .pyc files go to the user's Caches folder instead.
env.setdefault('PYTHONPYCACHEPREFIX', os.path.expanduser('~/Library/Caches/Image-Filter-Service/pycache'))

try:
    subprocess.Popen(
        [
            os.path.join(venv_bin, 'gunicorn'),
            '--bind', '0.0.0.0:10000',
            '--workers', '1',
            '--worker-class', 'gthread',
            '--threads', '8',
            '--timeout', '120',
            '--log-level', 'info',
            '--pid', pid_file,
            'app:app',
        ],
        env=env,
        stdout=open(os.path.join(log_dir, 'server.log'), 'a'),
        stderr=open(os.path.join(log_dir, 'server_error.log'), 'a'),
        start_new_session=True,
    )

    deadline = time.time() + 10
    while time.time() < deadline:
        time.sleep(0.2)
        if is_server_running():
            print("Server started successfully")
            sys.exit(0)
    print("Failed to start server")
    sys.exit(1)
except Exception as e:
    print(f"Error starting server: {e}")
    sys.exit(1)
