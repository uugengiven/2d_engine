/**
 * Fetches a URL and returns its body as an ArrayBuffer, optionally reporting
 * download progress as bytes arrive.
 *
 * `total` in the progress callback comes from the Content-Length response
 * header and is null if the server doesn't send one (also note: if the
 * response is compressed in transit, Content-Length reflects the compressed
 * size, not the decoded byte count).
 *
 * @param {string} url
 * @param {(progress: { loaded: number, total: number|null, url: string }) => void} [onProgress]
 * @returns {Promise<ArrayBuffer>}
 */
export async function fetchWithProgress(url, onProgress) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Fetch failed (${response.status}): ${url}`);

    if (!onProgress || !response.body) {
        return response.arrayBuffer();
    }

    const total = Number(response.headers.get('content-length')) || null;
    const reader = response.body.getReader();
    const chunks = [];
    let loaded = 0;

    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        loaded += value.byteLength;
        onProgress({ loaded, total, url });
    }

    const merged = new Uint8Array(loaded);
    let offset = 0;
    for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return merged.buffer;
}
