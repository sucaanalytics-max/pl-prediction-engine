"""
Shared utilities for the PL Prediction Engine pipeline.
HTTP retry, rate limiting, and error handling.
"""
import logging
import time
from typing import Optional

import requests

logger = logging.getLogger(__name__)


def fetch_with_retry(
    url: str,
    max_retries: int = 3,
    timeout: int = 30,
    backoff_base: float = 2.0,
    headers: Optional[dict] = None,
    params: Optional[dict] = None,
) -> requests.Response:
    """
    HTTP GET with exponential backoff retry.

    Args:
        url: URL to fetch
        max_retries: Maximum number of attempts (default 3)
        timeout: Request timeout in seconds
        backoff_base: Exponential backoff base (default 2s, 4s, 8s)
        headers: Optional request headers
        params: Optional query parameters

    Returns:
        requests.Response on success

    Raises:
        requests.RequestException: After all retries exhausted
    """
    last_error = None

    for attempt in range(1, max_retries + 1):
        try:
            resp = requests.get(
                url,
                timeout=timeout,
                headers=headers or {},
                params=params or {},
            )
            resp.raise_for_status()
            return resp

        except requests.exceptions.ConnectionError as e:
            last_error = e
            wait = backoff_base ** attempt
            logger.warning(
                f"  Connection error (attempt {attempt}/{max_retries}): {e}. "
                f"Retrying in {wait:.0f}s..."
            )
            time.sleep(wait)

        except requests.exceptions.Timeout as e:
            last_error = e
            wait = backoff_base ** attempt
            logger.warning(
                f"  Timeout (attempt {attempt}/{max_retries}): {e}. "
                f"Retrying in {wait:.0f}s..."
            )
            time.sleep(wait)

        except requests.exceptions.HTTPError as e:
            status_code = e.response.status_code if e.response is not None else 0

            # Don't retry client errors (except 429 rate limit)
            if 400 <= status_code < 500 and status_code != 429:
                logger.error(f"  HTTP {status_code} (not retryable): {url}")
                raise

            # Rate limited — respect Retry-After header
            if status_code == 429:
                retry_after = int(e.response.headers.get("Retry-After", 30))
                logger.warning(f"  Rate limited (429). Waiting {retry_after}s...")
                time.sleep(retry_after)
                last_error = e
                continue

            # Server errors — retry with backoff
            last_error = e
            wait = backoff_base ** attempt
            logger.warning(
                f"  HTTP {status_code} (attempt {attempt}/{max_retries}). "
                f"Retrying in {wait:.0f}s..."
            )
            time.sleep(wait)

        except requests.RequestException as e:
            last_error = e
            logger.error(f"  Request failed (attempt {attempt}/{max_retries}): {e}")
            if attempt < max_retries:
                time.sleep(backoff_base ** attempt)

    logger.error(f"  All {max_retries} attempts failed for {url}")
    raise last_error
