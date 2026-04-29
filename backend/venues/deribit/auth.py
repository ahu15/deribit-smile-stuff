import os
from dataclasses import dataclass


@dataclass
class DeribitCredentials:
    client_id: str
    client_secret: str
    testnet: bool = False

    @property
    def rest_base_url(self) -> str:
        host = "test.deribit.com" if self.testnet else "www.deribit.com"
        return f"https://{host}/api/v2"


def load_credentials() -> DeribitCredentials:
    return DeribitCredentials(
        client_id=os.environ.get("DERIBIT_CLIENT_ID", ""),
        client_secret=os.environ.get("DERIBIT_CLIENT_SECRET", ""),
        testnet=os.environ.get("DERIBIT_TESTNET", "").lower() in ("1", "true", "yes"),
    )
