
FROM localstack/localstack:3.8.1

COPY init/ready.d/01-create-queues.sh /etc/localstack/init/ready.d/01-create-queues.sh

RUN python3 -c "from pathlib import Path; p = Path('/etc/localstack/init/ready.d/01-create-queues.sh'); data = p.read_bytes(); data = data.removeprefix(b'\xef\xbb\xbf').replace(b'\r\n', b'\n').lstrip(b'\n'); p.write_bytes(data)" \
    && chmod 755 /etc/localstack/init/ready.d/01-create-queues.sh \
    && head -c 2 /etc/localstack/init/ready.d/01-create-queues.sh | od -An -tx1 | grep -q '23 21'
