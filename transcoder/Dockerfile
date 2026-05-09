FROM --platform=linux/amd64 jrottenberg/ffmpeg:8.0.2-alpine320-amd64

# Install Python 3 and pip (Alpine uses apk)
RUN apk add --no-cache \
    python3 \
    py3-pip \
    python3-dev \
    postgresql-dev \
    gcc \
    musl-dev

# Create a venv and use it for all subsequent commands
RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

CMD ["python", "worker.py"]
