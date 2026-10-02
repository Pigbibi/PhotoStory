"""Exercise the production Codex image path without reading private photos."""
import tempfile
from pathlib import Path

from PIL import Image

from process_batch import Stop, gateway, failure_reason


SCHEMA = {
    "type": "object",
    "properties": {"kind": {"type": "string", "enum": ["synthetic-test"]}},
    "required": ["kind"],
    "additionalProperties": False,
}


def main():
    with tempfile.TemporaryDirectory(prefix="photostory-gateway-smoke-") as tmp:
        work = Path(tmp)
        image = work / "synthetic.jpg"
        Image.new("RGB", (32, 32), (64, 128, 192)).save(image, "JPEG")
        result = gateway(
            'This is a synthetic color block, not a user photo. Return {"kind":"synthetic-test"}.',
            [{"id": "synthetic"}], [image], SCHEMA, work,
        )
        if result != {"kind": "synthetic-test"}:
            raise Stop("gateway_smoke_invalid")
    print("CodexGateway synthetic image verified.")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print("Gateway smoke diagnostic: reason=" + failure_reason(error))
        print("CodexGateway synthetic image verification failed.")
        raise SystemExit(1) from None
