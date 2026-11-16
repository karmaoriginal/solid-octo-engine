# Humanoide multidisciplina 3D

Simulación experimental en el navegador con React, Three.js y Rapier. El zip original se ha extraído en este proyecto.

## Ejecutar y comprobar

```bash
npm install
npm run dev
npm run build
npx tsc --noEmit
npx tsx scripts/multitask-test.ts
npx tsx scripts/stand.ts
npx tsx scripts/headless.ts 1 4 1
npx tsx scripts/workertest.ts
```

El build genera `dist/index.html` autocontenido. Algunos navegadores necesitan servirlo por HTTP para permitir workers.

## Controles

El botón **Actividad** cambia entre marcha, ejercicio con pesas, escalada con presas, boxeo con saco y parkour con huecos y muros. Cada actividad tiene su propia evolución, objetivos y escenario. La IA empieza sin dominar las habilidades; no se garantiza que aprenda a completarlas. Los modos Entrenar, Probar y Manual permiten evolucionar, ver la élite y controlar las 19 articulaciones. En marcha se pueden elegir terrenos desbloqueados. El menú permite ajustar gravedad, carga, fuerza, fatiga y fricción; modificar la física reinicia los episodios en curso. El arnés ayuda al equilibrio y se puede ajustar o retirar. El HUD muestra masa, peso, velocidad, fatiga y eventos; la hoja Músculos muestra activación y esfuerzo estimados.

## Física y músculos

Rapier simula cuerpos segmentados de aproximadamente 72 kg, gravedad, colisiones, 19 articulaciones limitadas, motores con torque, pesas, saco y obstáculos. Se usa un modelo muscular **simplificado** de activación, fatiga, recuperación y relación fuerza-velocidad. Fuerza, potencia, energía y reacción de apoyo son estimaciones, no mediciones ni una reproducción médica de la biomecánica. En escalada los agarres se aproximan con fuerzas elásticas limitadas; en boxeo el impacto se aproxima por impulso.

## IA y guardado

La política tiene 81 observaciones, osciladores por actividad, una red de reflejos y un router con adaptadores evolutivos (22.294 valores entrenables por cerebro). El banco disperso direcciona **100.000.000 valores de peso virtuales fijos**, generados determinísticamente a partir de una semilla; activa 12.000 valores por decisión. **No son 100 millones de parámetros independientes entrenables**, ni un modelo preentrenado: es una aproximación compacta adecuada al navegador. Entrenar 100 M de parámetros independientes requiere rediseñar el entrenamiento y una capacidad de cómputo y memoria considerablemente mayor.

Los archivos de cerebro usan formato v2 para las cinco disciplinas. Los guardados v1 del juego original no son compatibles por el cambio de arquitectura y no se sobrescriben automáticamente (se usa una clave de almacenamiento nueva). El cerebro se puede descargar y cargar desde el menú; el autoguardado es local al navegador.

## GitHub Pages

El flujo `.github/workflows/pages.yml` compila y publica el contenido de `dist` mediante GitHub Actions al actualizar `main` o la rama de trabajo. En la configuración del repositorio, Pages debe usar **GitHub Actions** como origen. Si el entorno `github-pages` restringe las ramas, debe permitir también la rama que se desee publicar.
