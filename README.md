# DiamondStats Backend

Servidor real que consulta la MLB Stats API en vivo (gratuita, sin llave)
y sirve datos frescos a la app — reemplaza los objetos `TEAM_RECORDS`,
`PLAYERS` y `PITCHERS` que hasta ahora traíamos a mano.

## Qué resuelve esto

- **Datos siempre actualizados**, sin que nadie tenga que copiar/pegar
  números de MLB.com.
- **Abridores probables reales por fecha**, no solo el "as de referencia"
  del equipo — esto conecta directo con lo que quedó pendiente antes.
- **Resuelve el problema de caché** que tuvimos con los Angels: como el
  navegador nunca llama a MLB directamente, no hereda esos problemas.

## Probarlo en tu computadora (2 minutos)

```bash
npm install
npm start
```

Luego abre en el navegador:
- `http://localhost:3000/api/standings`
- `http://localhost:3000/api/team/HOU/hitters`
- `http://localhost:3000/api/probable-pitchers?date=2026-08-11`

## Desplegarlo gratis (para que quede corriendo 24/7)

### Opción A: Railway (recomendada, más simple)
1. Crea una cuenta en [railway.app](https://railway.app) (gratis, con GitHub).
2. "New Project" → "Deploy from GitHub repo" → sube esta carpeta a un repo.
3. Railway detecta Node.js automáticamente y lo despliega.
4. Te da una URL pública tipo `https://tu-app.up.railway.app`.

### Opción B: Render
1. Crea cuenta en [render.com](https://render.com).
2. "New Web Service" → conecta el repo.
3. Build command: `npm install` — Start command: `npm start`.

## Conectar esto con el artifact de React

En el frontend, donde antes usábamos el objeto estático `TEAM_RECORDS`,
ahora se haría:

```js
const [standings, setStandings] = useState(null);

useEffect(() => {
  fetch("https://tu-backend-desplegado.up.railway.app/api/standings")
    .then((r) => r.json())
    .then((data) => setStandings(data.teams));
}, []);
```

## Próximos pasos lógicos

- Agregar endpoint de estadísticas de pitcheo real por equipo.
- Guardar un caché persistente (Redis o un archivo) en vez de memoria,
  para que sobreviva si el servidor se reinicia.
- Agregar los otros 3 deportes (cada uno con su propia API real:
  NBA, NFL, NHL también tienen stats APIs públicas).
