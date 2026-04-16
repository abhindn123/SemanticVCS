import os
import subprocess
import sys

def main():
    port = os.environ.get("PORT", "8000")
    print(f"Starting server on port {port}...")
    
    cmd = [
        "gunicorn", "app.main:app",
        "-w", "1",
        "-k", "uvicorn.workers.UvicornWorker",
        "--bind", f"0.0.0.0:{port}",
        "--timeout", "300",
        "--access-logfile", "-",
        "--error-logfile", "-"
    ]
    
    # Run the command and replace the current process
    # This ensures signals (like SIGTERM) are passed correctly to gunicorn
    os.execvp("gunicorn", cmd)

if __name__ == "__main__":
    main()
