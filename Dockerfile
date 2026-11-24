FROM python:3.12-slim
WORKDIR /app
COPY arena.py .
ENV PYTHONUNBUFFERED=1
CMD ["python", "arena.py"]
