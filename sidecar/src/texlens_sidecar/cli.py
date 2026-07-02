from __future__ import annotations

import uvicorn
import typer

from .app import create_app
from .config import get_settings


def serve(host: str = "127.0.0.1", port: int = 8765) -> None:
    settings = get_settings()
    settings.host = host
    settings.port = port
    uvicorn.run(create_app(settings), host=host, port=port, log_level="info")


def main() -> None:
    typer.run(serve)


if __name__ == "__main__":
    main()
