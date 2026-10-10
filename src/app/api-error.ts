export function apiErrorMessage(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const message = 'message' in error ? (error as { message: unknown }).message : null;
    const code = 'code' in error ? String((error as { code: unknown }).code) : '';
    if (typeof message === 'string' && !message.startsWith('Firebase: Error')) return message;
    if (code.includes('unauthenticated')) return 'Correo, contraseña o código de verificación incorrectos.';
    if (code.includes('account-exists-with-different-credential')) {
      return 'Esta cuenta ya usa correo y contraseña. Inicia sesión con ese método y vincula Google desde el menú de usuario.';
    }
    if (code.includes('popup-closed-by-user')) return 'Se cerró el inicio de sesión con Google antes de terminar.';
    if (code.includes('operation-not-allowed')) {
      return 'Habilita el proveedor de Google en Firebase Authentication.';
    }
    if (code.includes('permission-denied')) return 'No tienes permiso para realizar esta acción.';
    if (code.includes('unavailable') || code.includes('deadline-exceeded')) {
      return 'No se pudo conectar con Firebase. Inténtalo de nuevo.';
    }
  }
  return 'Ocurrió un error inesperado. Inténtalo de nuevo.';
}
