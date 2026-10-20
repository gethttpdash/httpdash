#!/bin/sh
# Regenerates the test certificates: a CA, a server certificate for localhost, and a client
# certificate (PEM, passphrase-protected PEM, and PFX). For tests only; valid for 100 years.
set -e
cd "$(dirname "$0")"
DAYS=36500
openssl req -x509 -newkey rsa:2048 -nodes -keyout ca.key -out ca.crt -days $DAYS -subj "/CN=HttpDash Test CA" 2>/dev/null
openssl req -newkey rsa:2048 -nodes -keyout server.key -out server.csr -subj "/CN=localhost" 2>/dev/null
printf "subjectAltName=DNS:localhost,IP:127.0.0.1\n" > server.ext
openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial -out server.crt -days $DAYS -extfile server.ext 2>/dev/null
openssl req -newkey rsa:2048 -nodes -keyout client.key -out client.csr -subj "/CN=httpdash-client" 2>/dev/null
printf "extendedKeyUsage=clientAuth\n" > client.ext
openssl x509 -req -in client.csr -CA ca.crt -CAkey ca.key -CAcreateserial -out client.crt -days $DAYS -extfile client.ext 2>/dev/null
openssl pkey -in client.key -aes256 -passout pass:secret -out client-encrypted.key
openssl pkcs12 -export -in client.crt -inkey client.key -passout pass:secret -out client.pfx -keypbe AES-256-CBC -certpbe AES-256-CBC -macalg sha256
# The CA key isn't needed by the tests, so it isn't kept.
rm -f server.csr client.csr server.ext client.ext ca.srl ca.key
