# Aula — Sistema de gestión escolar

Aplicación Angular conectada a Firebase Authentication y Cloud Firestore. El backend es una API Express desplegada en **Render** (carpeta `api/`). Las Cloud Functions ya no se usan.

## Arquitectura

- **Frontend**: Angular → Firebase Hosting (`sistema-escolar-fec8f.web.app`)
- **Backend**: Express + Firebase Admin SDK → Render (`sistema-escolar-api.onrender.com`)
- **Base de datos**: Cloud Firestore
- **Autenticación**: Firebase Auth (correo/contraseña y Google)
- **Correo**: Nodemailer con Gmail (SMTP) desde el backend en Render

## Configuración de Firebase

El proyecto Firebase asociado es `sistema-escolar-fec8f`. En Firebase Console confirma:

- Authentication → Sign-in method → Email/Password y Google habilitados.
- Cloud Firestore creado en modo producción.
- Firebase Hosting disponible.
- En Authentication → Settings → Authorized domains: agrega el dominio de Render.

Las reglas de Firestore en `firestore.rules` deniegan acceso directo al cliente; todos los datos se consultan a través de la API en Render.

## Configuración del backend (Render)

Copia `api/.env` a partir del ejemplo y completa los valores. En Render configura estas variables de entorno:

| Variable | Descripción |
|---|---|
| `FIREBASE_PROJECT_ID` | `sistema-escolar-fec8f` |
| `FIREBASE_WEB_API_KEY` | API key pública de Firebase |
| `SCHOOL_NAME` | Nombre del colegio |
| `SMTP_HOST` | `smtp.gmail.com` |
| `SMTP_PORT` | `465` |
| `SMTP_USER` | Cuenta Gmail |
| `SMTP_FROM` | Nombre y correo del remitente |
| `SMTP_PASSWORD` | Contraseña de aplicación de Google (secreta) |
| `GOOGLE_APPLICATION_CREDENTIALS_JSON` | JSON de cuenta de servicio en una sola línea (secreto) |
| `WEB_ORIGIN` | URL del frontend en Firebase Hosting |

`SMTP_PASSWORD` y `GOOGLE_APPLICATION_CREDENTIALS_JSON` son secretos — márcalos como tal en Render y nunca los subas al repositorio.

## Correo Gmail

Usa una **contraseña de aplicación** de Google (no la contraseña normal). Actívala en tu cuenta Google → Seguridad → Verificación en dos pasos → Contraseñas de aplicación.

## Despliegue

### Backend (Render)
El archivo `render.yaml` configura el servicio automáticamente. Solo conecta el repositorio en Render y agrega las variables secretas manualmente.

### Frontend (Firebase Hosting)
```powershell
npm run firebase:deploy
```
Esto compila Angular y despliega hosting + reglas de Firestore.

## Crear el administrador inicial

El script usa Firebase Admin SDK con las credenciales configuradas en `api/.env`:

```powershell
# Opción 1: con archivo de credenciales local
$env:GOOGLE_APPLICATION_CREDENTIALS = "C:\ruta-segura\firebase-admin.json"
npm run firebase:create-admin

# Opción 2: con JSON en variable de entorno
$env:GOOGLE_APPLICATION_CREDENTIALS_JSON = (Get-Content "C:\ruta-segura\firebase-admin.json" -Raw)
npm run firebase:create-admin
```

El script solicita correo, nombre y contraseña (sin mostrarla). Al primer inicio de sesión valida el OTP recibido por correo.

## Desarrollo local

```powershell
npm install
npm install --prefix api
npm start          # Angular en http://localhost:4200
```

Para que el login funcione localmente, el backend debe estar corriendo:

```powershell
npm --prefix api run dev   # API en http://localhost:3000
```

Para compilar y probar:

```powershell
npm run build
npm test -- --watch=false
npm --prefix api run build
```

## Verificación en dos pasos (2FA)

Todos los inicios de sesión (correo/contraseña y Google) requieren un código OTP de 6 dígitos enviado al correo del usuario. El código expira en 10 minutos y tiene límite de intentos por IP.

## Recuperación de contraseña

El flujo usa Firebase Authentication:
1. El usuario solicita recuperación → la API envía un correo con enlace de Firebase.
2. El enlace redirige a `https://tu-dominio.web.app/reset-password?oobCode=...`
3. El frontend captura el `oobCode` y permite crear una nueva contraseña.
