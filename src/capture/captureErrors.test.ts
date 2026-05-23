import { describe, expect, it } from 'vitest';
import { isScreenCapturePermissionError, screenCaptureStartMessage } from './captureErrors';

describe('capture errors', () => {
  it('recognizes the permission denied failure returned by embedded browsers', () => {
    const error = new DOMException('Permission denied', 'NotAllowedError');

    expect(isScreenCapturePermissionError(error)).toBe(true);
    expect(screenCaptureStartMessage(error)).toBe('Screen capture permission was denied. Open in Edge or Chrome, then choose the monitor.');
  });

  it('passes through non-permission capture failures', () => {
    const error = new Error('Video track ended');

    expect(isScreenCapturePermissionError(error)).toBe(false);
    expect(screenCaptureStartMessage(error)).toBe('Video track ended');
  });
});
