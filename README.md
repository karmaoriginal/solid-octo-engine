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


## Progreso y segundo plano

El último cerebro se autoguarda en el almacenamiento del navegador aproximadamente cada tres segundos si cambia la generación o disciplina; al abrir la página se restaura automáticamente. También se guardan la física y los ajustes de aprendizaje. Se conserva la última generación completa, no el estado físico ni los candidatos parciales. Descargar una copia desde el menú protege contra pérdida del almacenamiento, cambios de navegador o borrado de datos. Si falla el guardado aparece un aviso. La importación de archivos v2 anteriores sigue admitida.

La opción de segundo plano intenta seguir ejecutando el worker mientras la pestaña siga abierta; el sistema operativo o navegador puede limitarlo o suspenderlo, especialmente en móviles. No funciona con la pestaña cerrada, el navegador terminado o el teléfono apagado. GitHub Pages es alojamiento estático, sin CPU de servidor disponible para entrenar. WebGPU puede estar presente en algunos dispositivos, pero Rapier y el entrenamiento aquí siguen ejecutándose en CPU: no existe aceleración WebGPU implementada. Para entrenar siempre en línea sin usar el celular hace falta un servidor de cómputo externo, con su propio servicio y almacenamiento.

## Aprendizaje

El menú permite ajustar la guía de marcha y la exploración neuronal; cada cambio descarta únicamente la generación incompleta. La recompensa de marcha favorece el apoyo alterno y penaliza periodos en el aire y brazos excesivamente hacia atrás. Las mutaciones se concentran en la disciplina activa. La ayuda automática ya no se reduce solo por el paso de generaciones y puede recuperarse si la élite cae repetidamente. Son señales heurísticas y **no garantizan** aprender una marcha estable ni que 300 generaciones basten: los resultados dependen de la semilla, física y ajustes. La red y el banco virtual tienen las limitaciones indicadas arriba.

Pruebas adicionales: `npx tsx scripts/regression.ts` comprueba reinicio de candidatos, observaciones, mutaciones y restauración.

## Técnicas de robótica simuladas

En **Menú → Control robótico** se puede activar una capa de control de acción: limita la velocidad de cambio de las órdenes de la política y aplica una corrección proporcional-derivativa acotada basada en la inclinación y velocidad angular del tronco durante la marcha. No fuerza directamente el cuerpo ni actúa sobre el modo manual; el arnés es independiente. Las articulaciones siguen teniendo controladores PD y límites de torque.

También puede activarse **aleatorización de dominio** (por defecto desactivada): la gravedad y fricción varían hasta el porcentaje elegido en cada generación de entrenamiento. Todos los candidatos, incluyendo élite y media, usan la misma muestra determinista por generación, independientemente del número de agentes o del orden de evaluación. La comparación entre generaciones no es una evaluación fija; Probar y Manual usan condiciones nominales. Al cambiar estos ajustes se reinicia la generación incompleta. Los ajustes se guardan en el archivo v2; los guardados v2 anteriores conservan el controlador anterior hasta que se active esta opción.

Son aproximaciones inspiradas en robótica, no un sistema de transferencia a robots físicos, ni entrenamiento con hardware real. La estabilidad, los límites y la seguridad no están validados para un robot real; tampoco se garantiza una mejora de aprendizaje. `npx tsx scripts/robotics-test.ts` comprueba límites, condiciones comunes y compatibilidad de guardados.
