"""
Local HTTPS server for testing the PWA on multiple devices on the same network.

Camera access and Service Workers require a secure context (HTTPS or localhost).
This script generates a self-signed certificate and serves the app over HTTPS
so other phones/tablets on your Wi-Fi can access it.

Usage:
    pip install cryptography   (one-time)
    python serve_local.py

Then open on any device:
    https://<YOUR_LAN_IP>:8443

You'll see a browser warning about the self-signed certificate — tap
"Advanced" → "Proceed" (or "Accept the Risk") to continue.

Requirements: Python 3.7+, cryptography
"""

import http.server
import ipaddress
import ssl
import socket
import sys
import datetime
from pathlib import Path

PORT = 8443
SERVE_DIR = Path(__file__).parent
CERT_DIR = SERVE_DIR / ".certs"
CERT_FILE = CERT_DIR / "cert.pem"
KEY_FILE = CERT_DIR / "key.pem"


def get_lan_ips():
    """Get all LAN IP addresses for this machine."""
    ips = set()
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ip = info[4][0]
            if not ip.startswith("127."):
                ips.add(ip)
    except socket.gaierror:
        pass

    # Fallback: connect to a public IP to find the default route IP
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.settimeout(2)
        s.connect(("8.8.8.8", 80))
        ips.add(s.getsockname()[0])
        s.close()
    except Exception:
        pass

    return sorted(ips) or ["<could not detect>"]


def generate_cert(lan_ips):
    """Generate a self-signed certificate valid for localhost + LAN IPs."""
    CERT_DIR.mkdir(exist_ok=True)

    if CERT_FILE.exists() and KEY_FILE.exists():
        print(f"  Using existing certificate in .certs/")
        return

    try:
        from cryptography import x509
        from cryptography.x509.oid import NameOID
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import rsa
    except ImportError:
        print("\n  ❌  'cryptography' package is required.")
        print("      Run:  pip install cryptography")
        sys.exit(1)

    print("  Generating self-signed certificate...")

    # Generate RSA key
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)

    # Build Subject Alternative Names (so the cert works for all LAN IPs)
    san_names = [
        x509.DNSName("localhost"),
        x509.IPAddress(ipaddress.IPv4Address("127.0.0.1")),
    ]
    for ip in lan_ips:
        try:
            san_names.append(x509.IPAddress(ipaddress.IPv4Address(ip)))
        except ValueError:
            pass

    subject = issuer = x509.Name([
        x509.NameAttribute(NameOID.COMMON_NAME, "CropAI Local Dev"),
    ])

    cert = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(issuer)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(datetime.datetime.utcnow())
        .not_valid_after(datetime.datetime.utcnow() + datetime.timedelta(days=365))
        .add_extension(x509.SubjectAlternativeName(san_names), critical=False)
        .sign(key, hashes.SHA256())
    )

    CERT_FILE.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    KEY_FILE.write_bytes(
        key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.TraditionalOpenSSL,
            serialization.NoEncryption(),
        )
    )
    print("  ✅ Certificate created (valid for 1 year)")


class Handler(http.server.SimpleHTTPRequestHandler):
    """Serves files from the project directory."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(SERVE_DIR), **kwargs)

    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def log_message(self, format, *args):
        # Keep logs concise — only show page loads and errors
        status = str(args[1]) if len(args) > 1 else ""
        path = str(args[0]) if args else ""
        if status.startswith("4") or status.startswith("5") or "html" in path or path == "GET / HTTP/1.1":
            super().log_message(format, *args)


def main():
    lan_ips = get_lan_ips()

    print()
    print("=" * 56)
    print("  🌿 CropAI — Local HTTPS Server")
    print("=" * 56)
    print()

    generate_cert(lan_ips)
    print()

    # Create HTTPS server
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(str(CERT_FILE), str(KEY_FILE))

    server = http.server.HTTPServer(("0.0.0.0", PORT), Handler)
    server.socket = context.wrap_socket(server.socket, server_side=True)

    print("  Open on any device connected to the same Wi-Fi:")
    print()
    print(f"    This PC:       https://localhost:{PORT}")
    for ip in lan_ips:
        print(f"    Other devices: https://{ip}:{PORT}")
    print()
    print("  ┌─────────────────────────────────────────────────┐")
    print("  │  On phones/tablets, you'll see a certificate    │")
    print("  │  warning. Tap 'Advanced' → 'Proceed' to open.  │")
    print("  │  This is expected with self-signed certs.       │")
    print("  └─────────────────────────────────────────────────┘")
    print()
    print("  Press Ctrl+C to stop the server.")
    print("-" * 56)

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n  Server stopped.")
        server.server_close()


if __name__ == "__main__":
    main()
