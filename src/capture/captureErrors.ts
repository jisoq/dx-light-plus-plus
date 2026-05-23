export function isScreenCapturePermissionError(error: unknown): boolean {
  const { name, message } = errorParts(error);
  return name === 'NotAllowedError'
    || name === 'SecurityError'
    || /permission denied|permission.*denied|not allowed|denied by system/i.test(message);
}

export function screenCaptureStartMessage(error: unknown): string {
  if (isScreenCapturePermissionError(error)) {
    return 'Screen capture permission was denied. Open in Edge or Chrome, then choose the monitor.';
  }

  const { message } = errorParts(error);
  return message || 'Screen capture failed';
}

function errorParts(error: unknown): { name: string; message: string } {
  if (error instanceof Error || error instanceof DOMException) {
    return {
      name: error.name,
      message: error.message
    };
  }

  if (typeof error === 'object' && error !== null) {
    const record = error as Record<string, unknown>;
    return {
      name: typeof record.name === 'string' ? record.name : '',
      message: typeof record.message === 'string' ? record.message : ''
    };
  }

  return {
    name: '',
    message: typeof error === 'string' ? error : ''
  };
}
