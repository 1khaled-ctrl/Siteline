"""Reads one member out of a zip archive on a server, without downloading the archive.

The Artemis III site models come as 1 to 4 GB zips whose elevation model is about 70 MB of each. A zip's table of
contents sits at its end, so the last few megabytes name every member and where it starts; the member's own bytes
are then one more range request, inflated here. Handles Zip64 sizes and offsets; stored and deflated members only.
"""

import struct
import urllib.request
import zlib
from collections.abc import Callable
from dataclasses import dataclass

USER_AGENT = "siteline-pipeline"
CENTRAL_SIGNATURE = b"PK\x01\x02"
LOCAL_SIGNATURE = b"PK\x03\x04"
ZIP64_EXTRA = 0x0001
STORED, DEFLATED = 0, 8
TAIL_BYTES = 4 << 20

Fetch = Callable[[int, int], bytes]


@dataclass
class Member:
    name: str
    method: int
    compressed: int
    size: int
    header_offset: int


def url_fetch(url: str) -> Fetch:
    """Byte ranges of a file on a server that honours Range requests."""

    def fetch(start: int, size: int) -> bytes:
        headers = {"Range": f"bytes={start}-{start + size - 1}", "User-Agent": USER_AGENT}
        with urllib.request.urlopen(urllib.request.Request(url, headers=headers)) as response:
            data = response.read()
        if len(data) != size:
            raise OSError(f"{url}: asked for {size} bytes at {start}, got {len(data)}")
        return data

    return fetch


def content_length(url: str) -> int:
    request = urllib.request.Request(url, method="HEAD", headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request) as response:
        return int(response.headers["Content-Length"])


class Archive:
    """A zip archive read through `fetch(start, size)`; `total` is its length in bytes."""

    def __init__(self, fetch: Fetch, total: int) -> None:
        self.fetch = fetch
        self.total = total

    @classmethod
    def remote(cls, url: str, total: int | None = None) -> "Archive":
        return cls(url_fetch(url), content_length(url) if total is None else total)

    @classmethod
    def in_memory(cls, data: bytes) -> "Archive":
        return cls(lambda start, size: data[start : start + size], len(data))

    def members(self) -> list[Member]:
        """Every member named in the central directory, from the archive's last few megabytes."""
        size = min(TAIL_BYTES, self.total)
        return members_in(self.fetch(self.total - size, size))

    def find(self, suffix: str) -> Member:
        """The one member whose name ends with `suffix`."""
        found = [m for m in self.members() if m.name.endswith(suffix)]
        if len(found) != 1:
            raise ValueError(f"{len(found)} members end with {suffix!r}")
        return found[0]

    def data_offset(self, member: Member) -> int:
        """Where the member's bytes start: after its local header, whose name and extra fields vary in length."""
        header = self.fetch(member.header_offset, 30)
        if header[:4] != LOCAL_SIGNATURE:
            raise ValueError(f"{member.name}: no local header at {member.header_offset}")
        name_len, extra_len = struct.unpack_from("<HH", header, 26)
        return member.header_offset + 30 + name_len + extra_len

    def read(self, member: Member) -> bytes:
        """The member's uncompressed bytes, from a range request covering only it."""
        return inflate(self.fetch(self.data_offset(member), member.compressed), member)


def members_in(tail: bytes) -> list[Member]:
    out = []
    at = tail.find(CENTRAL_SIGNATURE)
    while 0 <= at <= len(tail) - 46:
        method = struct.unpack_from("<H", tail, at + 10)[0]
        compressed, size = struct.unpack_from("<II", tail, at + 20)
        name_len, extra_len, comment_len = struct.unpack_from("<HHH", tail, at + 28)
        header_offset = struct.unpack_from("<I", tail, at + 42)[0]
        name = tail[at + 46 : at + 46 + name_len].decode("utf-8", "replace")
        extra = tail[at + 46 + name_len : at + 46 + name_len + extra_len]
        size, compressed, header_offset = _zip64(extra, size, compressed, header_offset)
        out.append(Member(name, method, compressed, size, header_offset))
        at = tail.find(CENTRAL_SIGNATURE, at + 46 + name_len + extra_len + comment_len)
    return out


def _zip64(extra: bytes, size: int, compressed: int, header_offset: int) -> tuple[int, int, int]:
    """The 64-bit sizes and offset from a Zip64 extra field, for any 32-bit field that is maxed out."""
    at = 0
    while at + 4 <= len(extra):
        kind, length = struct.unpack_from("<HH", extra, at)
        if kind == ZIP64_EXTRA:
            values = list(struct.unpack_from(f"<{length // 8}Q", extra, at + 4))
            if size == 0xFFFFFFFF and values:
                size = values.pop(0)
            if compressed == 0xFFFFFFFF and values:
                compressed = values.pop(0)
            if header_offset == 0xFFFFFFFF and values:
                header_offset = values.pop(0)
            break
        at += 4 + length
    return size, compressed, header_offset


def inflate(data: bytes, member: Member) -> bytes:
    if member.method == STORED:
        out = data
    elif member.method == DEFLATED:
        out = zlib.decompress(data, -15)
    else:
        raise ValueError(f"{member.name}: compression method {member.method} is not handled")
    if len(out) != member.size:
        raise ValueError(f"{member.name}: inflated to {len(out)} bytes, expected {member.size}")
    return out
