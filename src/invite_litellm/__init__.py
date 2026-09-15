import os


def main() -> None:
    import uvicorn

    from invite_litellm.app import app

    uvicorn.run(
        app,
        host=os.environ.get("HOST", "127.0.0.1"),
        port=int(os.environ.get("PORT", "8000")),
    )
