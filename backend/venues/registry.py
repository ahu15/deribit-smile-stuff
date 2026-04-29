from backend.venues.base import VenueAdapter

_registry: dict[str, VenueAdapter] = {}


def register(name: str, adapter: VenueAdapter) -> None:
    _registry[name] = adapter


def get(name: str) -> VenueAdapter:
    if name not in _registry:
        raise KeyError(f"venue '{name}' not registered")
    return _registry[name]


def all_venues() -> dict[str, VenueAdapter]:
    return dict(_registry)
