# Report server image. Build from the repo root:
#   docker build -f server/Dockerfile -t ai-platform-report:latest .
# Stdlib only — no pip install, so it builds offline from the local python:3.12-slim.
FROM python:3.12-slim
WORKDIR /app
COPY server/app.py /app/app.py
COPY site-template /app/site-template
COPY client /app/client
COPY skills /app/skills
# checkouts may be 0600 (umask 077); the container runs as the host user, not root
RUN chmod -R a+rX /app
ENV SITE_DIR=/site PORT=8090 PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
EXPOSE 8090
HEALTHCHECK --interval=60s --timeout=5s CMD python -c "import os,urllib.request; urllib.request.urlopen('http://127.0.0.1:%s/api/health' % os.environ.get('PORT', '8090'), timeout=4)"
CMD ["python", "/app/app.py"]
