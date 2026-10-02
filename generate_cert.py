import datetime
import ipaddress

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID

# --- Optional: Trage hier deine Windows-WLAN-IP ein (aus "ipconfig"), ---
# --- damit das Zertifikat auch dafür gültig ist. Sonst reicht localhost. ---
MEINE_IP = "192.168.1.42"  # <-- anpassen!

key = rsa.generate_private_key(public_exponent=65537, key_size=2048)

subject = issuer = x509.Name([
    x509.NameAttribute(NameOID.COMMON_NAME, u"localhost"),
])

san_list = [
    x509.DNSName(u"localhost"),
    x509.IPAddress(ipaddress.ip_address("127.0.0.1")),
]
try:
    san_list.append(x509.IPAddress(ipaddress.ip_address(MEINE_IP)))
except ValueError:
    pass

cert = (
    x509.CertificateBuilder()
    .subject_name(subject)
    .issuer_name(issuer)
    .public_key(key.public_key())
    .serial_number(x509.random_serial_number())
    .not_valid_before(datetime.datetime.utcnow())
    .not_valid_after(datetime.datetime.utcnow() + datetime.timedelta(days=365))
    .add_extension(x509.SubjectAlternativeName(san_list), critical=False)
    .sign(key, hashes.SHA256())
)

with open("key.pem", "wb") as f:
    f.write(key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.TraditionalOpenSSL,
        encryption_algorithm=serialization.NoEncryption(),
    ))

with open("cert.pem", "wb") as f:
    f.write(cert.public_bytes(serialization.Encoding.PEM))

print("Fertig: cert.pem und key.pem wurden erstellt.")
