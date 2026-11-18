# Dynamic Island

Recreación interactiva de la Dynamic Island del iPhone hecha con HTML, CSS y JavaScript sin dependencias. La isla cambia de forma con animaciones de resorte (*springs*) como las de iOS, responde a toques y gestos, y lleva un reproductor de música funcional.

> Autor: **LilSeniorJ**

## Características

### La isla
- **Tres estados**, como en iOS:
  - **Reposo (idle):** píldora negra con la cámara.
  - **Compacta (compact):** se ensancha cuando hay una actividad; muestra la carátula a la izquierda y las ondas de audio a la derecha.
  - **Expandida (expanded):** el reproductor completo.
- **Animaciones con springs físicos:** la forma rebota un poco al abrirse, se puede interrumpir a mitad de camino y hereda la velocidad del dedo al soltar.
- **Gestos:**
  - Toque para abrir, con un pequeño "squish" al presionar.
  - Arrastrar hacia abajo en la isla compacta la abre siguiendo el dedo.
  - Arrastrar hacia arriba en la isla expandida la cierra (con efecto *rubber band* en los bordes).
  - Tocar fuera la cierra.
- **La actividad se retira sola:** si la música queda en pausa con la isla cerrada, a los 6 s vuelve a reposo.

### Reproductor
- Reproducir / pausar con transición del icono.
- Barra de progreso que avanza en tiempo real y se puede arrastrar; se engrosa al tocarla, como en iOS.
- Anterior / siguiente con animación de cambio de canción. Si la canción lleva más de 3 s, "anterior" la reinicia.
- El ecualizador se tiñe con el color de cada carátula y se detiene en pausa.

### Teléfono
- Barra de estado con hora real, señal, wifi y batería. Si el navegador lo permite, muestra el nivel real de batería y si está cargando.
- Pantalla de bloqueo con fecha, reloj grande y botones de linterna y cámara.
- Cuatro acabados: Deep Purple, Gold, Space Black y Silver. En los fondos claros, la barra de estado pasa a texto oscuro. El color elegido se recuerda entre visitas.
- Adaptable a cualquier pantalla: todo el teléfono se mide en relación a su alto.

### Accesibilidad
- Se puede usar entero con teclado:
  - `Enter`/`Espacio` abre la isla y lleva el foco a "Pausar".
  - `Esc` la cierra y devuelve el foco.
  - La barra de progreso es un *slider* que se mueve con las flechas, `Inicio` y `Fin`.
- Etiquetas ARIA que cambian con el estado ("Reproduciendo: …", "En pausa: …"), y los cambios de canción se anuncian a lectores de pantalla.
- Los controles ocultos no se pueden enfocar (`inert`).
- Respeta `prefers-reduced-motion`.

## Cómo verlo

No necesita instalación. Abre `index.html` en el navegador o, mejor, sírvelo en local:

```bash
python3 -m http.server 8000
# luego abre http://localhost:8000
```

> Si antes abriste una versión anterior, recarga sin caché (`Cmd + Shift + R`) para que el navegador no use el CSS viejo.

**Navegadores:** versiones actuales de Chrome, Edge, Safari y Firefox. Usa `:has()`, `inert` y la Web Animations API.

## Estructura

```
├── index.html   # Marcado: teléfono, barra de estado, isla, pantalla de bloqueo y paleta
├── style.css    # Estilos y estados visuales de la isla (data-island en .phone)
└── script.js    # Motor de springs, máquina de estados, gestos, reproductor y reloj
```

## Cómo funciona

### Estados
`script.js` guarda el estado actual y lo refleja en `data-island` sobre `.phone` (`idle`, `compact` o `expanded`). El CSS usa ese atributo para mostrar u ocultar cada vista y para adaptar la barra de estado. La reproducción se refleja igual en `data-playing`.

### Springs
La isla no se anima con transiciones CSS. El ancho, el alto, el radio y la escala son *springs* físicos que se calculan en cada frame con `requestAnimationFrame`. Se configuran como en SwiftUI, con dos valores:

- `response`: cuánto dura la animación.
- `damping`: cuánto rebota (1 = sin rebote).

Así una animación se puede interrumpir y la velocidad de un gesto pasa directamente a la animación al soltar.

```js
const MOTION = {
  open:   [0.5, 0.72],  // expandir: rebote visible
  close:  [0.44, 0.86], // contraer: más firme
  appear: [0.55, 0.62], // aparece una actividad
  vanish: [0.42, 0.92], // termina la actividad
};
```

### Contenido sin saltos
La vista expandida tiene siempre su tamaño final y está centrada. La isla la va recortando (`overflow: hidden`) mientras crece, así el texto no se reacomoda durante la animación.

## Personalizar

- **Canciones:** edita el arreglo `tracks` en `script.js` (título, artista, duración en segundos, degradado de la carátula y colores del ecualizador).
- **Medidas de la isla:** cambia las variables en `.phone` dentro de `style.css` (`--island-w`, `--compact-w`, `--exp-w`, `--exp-h`, `--exp-r`…). El JavaScript las lee de ahí, así que no hay que tocar nada más.
- **Sensación de las animaciones:** ajusta `MOTION` en `script.js`.

## Próximos pasos

- [ ] Más actividades en la isla: temporizador, llamada entrante, carga de batería, AirPods conectados.
- [ ] Dos actividades a la vez (isla dividida en dos burbujas).
- [ ] Audio real con `<audio>` y Media Session API.
- [ ] Deploy en GitHub Pages.
