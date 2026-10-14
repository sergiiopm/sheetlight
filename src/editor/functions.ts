/**
 * Function catalog for autocomplete and signature help: en-US names (formulas
 * are always English), the Spanish Excel name (so `=BUSCARV` finds VLOOKUP),
 * Spanish descriptions and argument names/descriptions.
 *
 * Argument spec syntax (compact on purpose, ~200 entries):
 *   "nombre: descripción | [opcional]: descripción | valor2...: repetible"
 * `[x]` marks an optional argument and a trailing `...` a repeating one.
 */

export type FunctionCategory =
  | "math"
  | "statistical"
  | "logical"
  | "lookup"
  | "array"
  | "text"
  | "date"
  | "financial"
  | "info";

export const CATEGORY_LABELS: Record<FunctionCategory, string> = {
  math: "Matemáticas y trigonometría",
  statistical: "Estadísticas",
  logical: "Lógicas",
  lookup: "Búsqueda y referencia",
  array: "Matrices dinámicas",
  text: "Texto",
  date: "Fecha y hora",
  financial: "Financieras",
  info: "Información",
};

export interface FunctionArg {
  readonly name: string;
  readonly description: string;
  readonly optional: boolean;
  readonly repeating: boolean;
}

export interface FunctionInfo {
  /** en-US name, upper case (`SUMIFS`). */
  readonly name: string;
  /** Spanish Excel name (`SUMAR.SI.CONJUNTO`), for search only. */
  readonly es: string;
  readonly category: FunctionCategory;
  readonly description: string;
  readonly args: ReadonlyArray<FunctionArg>;
}

function parseArgs(spec: string): FunctionArg[] {
  if (spec.trim() === "") return [];
  return spec.split(" | ").map((part) => {
    const idx = part.indexOf(":");
    let name = (idx >= 0 ? part.slice(0, idx) : part).trim();
    const description = idx >= 0 ? part.slice(idx + 1).trim() : "";
    let repeating = false;
    if (name.endsWith("...")) {
      repeating = true;
      name = name.slice(0, -3);
    }
    let optional = false;
    if (name.startsWith("[") && name.endsWith("]")) {
      optional = true;
      name = name.slice(1, -1);
    }
    return { name, description, optional, repeating };
  });
}

type Row = readonly [name: string, es: string, description: string, args: string];

const RAW: Record<FunctionCategory, ReadonlyArray<Row>> = {
  math: [
    ["SUM", "SUMA", "Suma todos los números de un rango de celdas.", "número1: Primer número, celda o rango que se va a sumar | [número2]...: Números, celdas o rangos adicionales"],
    ["SUMIF", "SUMAR.SI", "Suma las celdas que cumplen un criterio.", "rango: Rango de celdas que se evalúa | criterio: Condición que determina qué celdas se suman (p. ej. \">10\") | [rango_suma]: Celdas que se suman; si se omite, se usa rango"],
    ["SUMIFS", "SUMAR.SI.CONJUNTO", "Suma las celdas que cumplen varios criterios.", "rango_suma: Celdas que se suman | rango_criterios1: Rango evaluado con criterio1 | criterio1: Condición para rango_criterios1 | [rango_criterios2]...: Rangos y criterios adicionales, por pares"],
    ["SUMPRODUCT", "SUMAPRODUCTO", "Devuelve la suma de los productos de los rangos o matrices correspondientes.", "matriz1: Primera matriz cuyos componentes se multiplican | [matriz2]...: Matrices adicionales del mismo tamaño"],
    ["SUMSQ", "SUMA.CUADRADOS", "Devuelve la suma de los cuadrados de los argumentos.", "número1: Primer número o rango | [número2]...: Números adicionales"],
    ["PRODUCT", "PRODUCTO", "Multiplica todos los números dados como argumentos.", "número1: Primer número o rango | [número2]...: Números adicionales"],
    ["ROUND", "REDONDEAR", "Redondea un número al número de decimales especificado.", "número: Número que se redondea | núm_decimales: Decimales (negativo redondea a la izquierda de la coma)"],
    ["ROUNDUP", "REDONDEAR.MAS", "Redondea un número hacia arriba, alejándose de cero.", "número: Número que se redondea | núm_decimales: Número de decimales"],
    ["ROUNDDOWN", "REDONDEAR.MENOS", "Redondea un número hacia abajo, hacia cero.", "número: Número que se redondea | núm_decimales: Número de decimales"],
    ["MROUND", "REDOND.MULT", "Redondea un número al múltiplo deseado.", "número: Número que se redondea | múltiplo: Múltiplo al que se redondea"],
    ["INT", "ENTERO", "Redondea un número hasta el entero inferior más próximo.", "número: Número real que se redondea hacia abajo"],
    ["TRUNC", "TRUNCAR", "Trunca un número quitando la parte decimal.", "número: Número que se trunca | [núm_decimales]: Precisión del truncamiento (0 por defecto)"],
    ["MOD", "RESIDUO", "Devuelve el resto de una división.", "número: Dividendo | núm_divisor: Divisor"],
    ["QUOTIENT", "COCIENTE", "Devuelve la parte entera de una división.", "numerador: Dividendo | denominador: Divisor"],
    ["ABS", "ABS", "Devuelve el valor absoluto de un número.", "número: Número real"],
    ["SIGN", "SIGNO", "Devuelve el signo de un número: 1, 0 o -1.", "número: Número real"],
    ["POWER", "POTENCIA", "Devuelve el resultado de elevar un número a una potencia.", "número: Base | potencia: Exponente"],
    ["SQRT", "RAIZ", "Devuelve la raíz cuadrada de un número.", "número: Número del que se calcula la raíz"],
    ["EXP", "EXP", "Devuelve e elevado a la potencia de un número.", "número: Exponente aplicado a la base e"],
    ["LN", "LN", "Devuelve el logaritmo natural de un número.", "número: Número real positivo"],
    ["LOG", "LOG", "Devuelve el logaritmo de un número en la base especificada.", "número: Número real positivo | [base]: Base del logaritmo (10 por defecto)"],
    ["LOG10", "LOG10", "Devuelve el logaritmo en base 10 de un número.", "número: Número real positivo"],
    ["PI", "PI", "Devuelve el valor de pi con 15 dígitos de precisión.", ""],
    ["CEILING", "MULTIPLO.SUPERIOR", "Redondea un número hacia arriba al múltiplo significativo más próximo.", "número: Valor que se redondea | cifra_significativa: Múltiplo al que se redondea"],
    ["CEILING.MATH", "MULTIPLO.SUPERIOR.MAT", "Redondea un número hacia arriba al entero o múltiplo significativo más próximo.", "número: Valor que se redondea | [cifra_significativa]: Múltiplo (1 por defecto) | [moda]: Sentido para números negativos"],
    ["FLOOR", "MULTIPLO.INFERIOR", "Redondea un número hacia abajo al múltiplo significativo más próximo.", "número: Valor que se redondea | cifra_significativa: Múltiplo al que se redondea"],
    ["FLOOR.MATH", "MULTIPLO.INFERIOR.MAT", "Redondea un número hacia abajo al entero o múltiplo significativo más próximo.", "número: Valor que se redondea | [cifra_significativa]: Múltiplo (1 por defecto) | [moda]: Sentido para números negativos"],
    ["RAND", "ALEATORIO", "Devuelve un número aleatorio mayor o igual que 0 y menor que 1.", ""],
    ["RANDBETWEEN", "ALEATORIO.ENTRE", "Devuelve un número entero aleatorio entre los números especificados.", "inferior: Entero más pequeño que puede devolver | superior: Entero más grande que puede devolver"],
    ["RANDARRAY", "MATRIZALEAT", "Devuelve una matriz de números aleatorios.", "[filas]: Número de filas | [columnas]: Número de columnas | [mín]: Valor mínimo | [máx]: Valor máximo | [entero]: VERDADERO para enteros"],
    ["SUBTOTAL", "SUBTOTALES", "Devuelve un subtotal en una lista o base de datos.", "núm_función: Función de resumen (1-11 incluye ocultas, 101-111 las excluye; 9 = SUMA) | ref1: Primer rango | [ref2]...: Rangos adicionales"],
    ["AGGREGATE", "AGREGAR", "Devuelve un agregado de una lista, con opción de omitir errores y filas ocultas.", "núm_función: Función de resumen (1-19) | opciones: Valores que se omiten | ref1: Primer rango | [ref2]...: Argumentos adicionales"],
    ["GCD", "M.C.D", "Devuelve el máximo común divisor.", "número1: Primer valor | [número2]...: Valores adicionales"],
    ["LCM", "M.C.M", "Devuelve el mínimo común múltiplo.", "número1: Primer valor | [número2]...: Valores adicionales"],
    ["FACT", "FACT", "Devuelve el factorial de un número.", "número: Número no negativo"],
    ["COMBIN", "COMBINAT", "Devuelve el número de combinaciones para un número determinado de elementos.", "número: Número total de elementos | tamaño: Elementos de cada combinación"],
    ["EVEN", "REDONDEA.PAR", "Redondea un número hasta el entero par más próximo.", "número: Valor que se redondea"],
    ["ODD", "REDONDEA.IMPAR", "Redondea un número hasta el entero impar más próximo.", "número: Valor que se redondea"],
    ["RADIANS", "RADIANES", "Convierte grados en radianes.", "ángulo: Ángulo en grados"],
    ["DEGREES", "GRADOS", "Convierte radianes en grados.", "ángulo: Ángulo en radianes"],
    ["SIN", "SENO", "Devuelve el seno de un ángulo.", "número: Ángulo en radianes"],
    ["COS", "COS", "Devuelve el coseno de un ángulo.", "número: Ángulo en radianes"],
    ["TAN", "TAN", "Devuelve la tangente de un ángulo.", "número: Ángulo en radianes"],
    ["MMULT", "MMULT", "Devuelve el producto matricial de dos matrices.", "matriz1: Primera matriz | matriz2: Segunda matriz"],
  ],
  statistical: [
    ["AVERAGE", "PROMEDIO", "Devuelve el promedio (media aritmética) de los argumentos.", "número1: Primer número, celda o rango | [número2]...: Números adicionales"],
    ["AVERAGEA", "PROMEDIOA", "Devuelve el promedio de los argumentos, incluidos textos y valores lógicos.", "valor1: Primer valor | [valor2]...: Valores adicionales"],
    ["AVERAGEIF", "PROMEDIO.SI", "Devuelve el promedio de las celdas que cumplen un criterio.", "rango: Celdas que se evalúan | criterio: Condición | [rango_promedio]: Celdas que se promedian"],
    ["AVERAGEIFS", "PROMEDIO.SI.CONJUNTO", "Devuelve el promedio de las celdas que cumplen varios criterios.", "rango_promedio: Celdas que se promedian | rango_criterios1: Rango evaluado con criterio1 | criterio1: Condición | [rango_criterios2]...: Rangos y criterios adicionales, por pares"],
    ["COUNT", "CONTAR", "Cuenta el número de celdas que contienen números.", "valor1: Primer valor, celda o rango | [valor2]...: Valores adicionales"],
    ["COUNTA", "CONTARA", "Cuenta el número de celdas no vacías.", "valor1: Primer valor, celda o rango | [valor2]...: Valores adicionales"],
    ["COUNTBLANK", "CONTAR.BLANCO", "Cuenta el número de celdas vacías de un rango.", "rango: Rango en el que se cuentan las celdas vacías"],
    ["COUNTIF", "CONTAR.SI", "Cuenta las celdas de un rango que cumplen un criterio.", "rango: Rango de celdas que se cuentan | criterio: Condición (número, expresión o texto)"],
    ["COUNTIFS", "CONTAR.SI.CONJUNTO", "Cuenta las celdas que cumplen varios criterios.", "rango_criterios1: Primer rango evaluado | criterio1: Condición para el primer rango | [rango_criterios2]...: Rangos y criterios adicionales, por pares"],
    ["MIN", "MIN", "Devuelve el valor mínimo de una lista de valores.", "número1: Primer número o rango | [número2]...: Números adicionales"],
    ["MAX", "MAX", "Devuelve el valor máximo de una lista de valores.", "número1: Primer número o rango | [número2]...: Números adicionales"],
    ["MINIFS", "MIN.SI.CONJUNTO", "Devuelve el valor mínimo de las celdas que cumplen varios criterios.", "rango_mín: Celdas de las que se obtiene el mínimo | rango_criterios1: Rango evaluado | criterio1: Condición | [rango_criterios2]...: Rangos y criterios adicionales"],
    ["MAXIFS", "MAX.SI.CONJUNTO", "Devuelve el valor máximo de las celdas que cumplen varios criterios.", "rango_máx: Celdas de las que se obtiene el máximo | rango_criterios1: Rango evaluado | criterio1: Condición | [rango_criterios2]...: Rangos y criterios adicionales"],
    ["MEDIAN", "MEDIANA", "Devuelve la mediana de los números dados.", "número1: Primer número o rango | [número2]...: Números adicionales"],
    ["MODE", "MODA", "Devuelve el valor más frecuente de un rango.", "número1: Primer número o rango | [número2]...: Números adicionales"],
    ["MODE.SNGL", "MODA.UNO", "Devuelve el valor más frecuente de un rango.", "número1: Primer número o rango | [número2]...: Números adicionales"],
    ["STDEV", "DESVEST", "Calcula la desviación estándar de una muestra.", "número1: Primer número o rango | [número2]...: Números adicionales"],
    ["STDEV.S", "DESVEST.M", "Calcula la desviación estándar de una muestra.", "número1: Primer número o rango | [número2]...: Números adicionales"],
    ["STDEV.P", "DESVEST.P", "Calcula la desviación estándar de toda la población.", "número1: Primer número o rango | [número2]...: Números adicionales"],
    ["VAR", "VAR", "Calcula la varianza de una muestra.", "número1: Primer número o rango | [número2]...: Números adicionales"],
    ["VAR.S", "VAR.S", "Calcula la varianza de una muestra.", "número1: Primer número o rango | [número2]...: Números adicionales"],
    ["VAR.P", "VAR.P", "Calcula la varianza de toda la población.", "número1: Primer número o rango | [número2]...: Números adicionales"],
    ["LARGE", "K.ESIMO.MAYOR", "Devuelve el k-ésimo valor mayor de un conjunto de datos.", "matriz: Rango de datos | k: Posición desde el mayor (1 = el mayor)"],
    ["SMALL", "K.ESIMO.MENOR", "Devuelve el k-ésimo valor menor de un conjunto de datos.", "matriz: Rango de datos | k: Posición desde el menor (1 = el menor)"],
    ["RANK", "JERARQUIA", "Devuelve la posición de un número en una lista.", "número: Número cuya posición se busca | referencia: Lista de números | [orden]: 0 o se omite = descendente; otro valor = ascendente"],
    ["RANK.EQ", "JERARQUIA.EQV", "Devuelve la posición de un número en una lista; los empates reciben la posición más alta.", "número: Número cuya posición se busca | referencia: Lista de números | [orden]: 0 = descendente; otro valor = ascendente"],
    ["RANK.AVG", "JERARQUIA.MEDIA", "Devuelve la posición de un número en una lista; los empates reciben la posición media.", "número: Número cuya posición se busca | referencia: Lista de números | [orden]: 0 = descendente; otro valor = ascendente"],
    ["PERCENTILE", "PERCENTIL", "Devuelve el percentil k de los valores de un rango.", "matriz: Rango de datos | k: Percentil entre 0 y 1"],
    ["PERCENTILE.INC", "PERCENTIL.INC", "Devuelve el percentil k (incluidos 0 y 1) de los valores de un rango.", "matriz: Rango de datos | k: Percentil entre 0 y 1"],
    ["PERCENTILE.EXC", "PERCENTIL.EXC", "Devuelve el percentil k (excluidos 0 y 1) de los valores de un rango.", "matriz: Rango de datos | k: Percentil entre 0 y 1, sin incluirlos"],
    ["PERCENTRANK", "RANGO.PERCENTIL", "Devuelve el rango porcentual de un valor en un conjunto de datos.", "matriz: Rango de datos | x: Valor cuyo rango se busca | [cifra_significativa]: Dígitos significativos"],
    ["QUARTILE", "CUARTIL", "Devuelve el cuartil de un conjunto de datos.", "matriz: Rango de datos | cuartil: 0 = mínimo, 1 = primer cuartil, 2 = mediana, 3 = tercer cuartil, 4 = máximo"],
    ["QUARTILE.INC", "CUARTIL.INC", "Devuelve el cuartil de un conjunto de datos (incluidos 0 y 1).", "matriz: Rango de datos | cuartil: Valor de 0 a 4"],
    ["CORREL", "COEF.DE.CORREL", "Devuelve el coeficiente de correlación entre dos conjuntos de datos.", "matriz1: Primer rango de valores | matriz2: Segundo rango de valores"],
    ["FORECAST", "PRONOSTICO", "Calcula un valor futuro mediante regresión lineal.", "x: Punto para el que se predice un valor | conocido_y: Valores dependientes | conocido_x: Valores independientes"],
    ["FORECAST.LINEAR", "PRONOSTICO.LINEAL", "Calcula un valor futuro mediante regresión lineal.", "x: Punto para el que se predice un valor | conocido_y: Valores dependientes | conocido_x: Valores independientes"],
    ["TREND", "TENDENCIA", "Devuelve valores de una tendencia lineal.", "conocido_y: Valores y conocidos | [conocido_x]: Valores x conocidos | [nueva_matriz_x]: Nuevos valores x | [constante]: FALSO fuerza b = 0"],
    ["SLOPE", "PENDIENTE", "Devuelve la pendiente de la recta de regresión lineal.", "conocido_y: Valores dependientes | conocido_x: Valores independientes"],
    ["INTERCEPT", "INTERSECCION.EJE", "Devuelve el punto de intersección de la recta de regresión con el eje y.", "conocido_y: Valores dependientes | conocido_x: Valores independientes"],
    ["RSQ", "COEFICIENTE.R2", "Devuelve el cuadrado del coeficiente de correlación de Pearson.", "conocido_y: Valores dependientes | conocido_x: Valores independientes"],
    ["GEOMEAN", "MEDIA.GEOM", "Devuelve la media geométrica.", "número1: Primer número o rango | [número2]...: Números adicionales"],
    ["NORM.DIST", "DISTR.NORM.N", "Devuelve la distribución normal.", "x: Valor | media: Media aritmética | desv_estándar: Desviación estándar | acumulado: VERDADERO = función de distribución acumulativa"],
    ["NORM.INV", "INV.NORM", "Devuelve el inverso de la distribución normal acumulativa.", "probabilidad: Probabilidad | media: Media aritmética | desv_estándar: Desviación estándar"],
  ],
  logical: [
    ["IF", "SI", "Comprueba si se cumple una condición y devuelve un valor si es VERDADERO y otro si es FALSO.", "prueba_lógica: Condición que se evalúa (p. ej. A1>10) | [valor_si_verdadero]: Valor devuelto si la condición es VERDADERO | [valor_si_falso]: Valor devuelto si la condición es FALSO"],
    ["IFS", "SI.CONJUNTO", "Comprueba varias condiciones y devuelve el valor de la primera que sea VERDADERO.", "prueba_lógica1: Primera condición | valor_si_verdadero1: Valor si prueba_lógica1 es VERDADERO | [prueba_lógica2]...: Condiciones y valores adicionales, por pares"],
    ["IFERROR", "SI.ERROR", "Devuelve un valor si la expresión es un error y el valor de la expresión si no lo es.", "valor: Expresión que se comprueba | valor_si_error: Valor devuelto si hay error"],
    ["IFNA", "SI.ND", "Devuelve un valor si la expresión da #N/A y el valor de la expresión si no.", "valor: Expresión que se comprueba | valor_si_nd: Valor devuelto si el resultado es #N/A"],
    ["AND", "Y", "Devuelve VERDADERO si todos los argumentos son VERDADERO.", "valor_lógico1: Primera condición | [valor_lógico2]...: Condiciones adicionales"],
    ["OR", "O", "Devuelve VERDADERO si algún argumento es VERDADERO.", "valor_lógico1: Primera condición | [valor_lógico2]...: Condiciones adicionales"],
    ["NOT", "NO", "Invierte el valor lógico del argumento.", "valor_lógico: Valor o expresión que se invierte"],
    ["XOR", "XO", "Devuelve el O exclusivo lógico de todos los argumentos.", "valor_lógico1: Primera condición | [valor_lógico2]...: Condiciones adicionales"],
    ["SWITCH", "CAMBIAR", "Evalúa una expresión frente a una lista de valores y devuelve el resultado del primer valor coincidente.", "expresión: Valor que se compara | valor1: Primer valor de comparación | resultado1: Resultado si coincide con valor1 | [valor2]...: Pares valor/resultado adicionales y, al final, un valor predeterminado opcional"],
    ["TRUE", "VERDADERO", "Devuelve el valor lógico VERDADERO.", ""],
    ["FALSE", "FALSO", "Devuelve el valor lógico FALSO.", ""],
    ["LET", "LET", "Asigna nombres a resultados de cálculo dentro de una fórmula.", "nombre1: Primer nombre | valor_nombre1: Valor asignado a nombre1 | cálculo_o_nombre2...: Cálculo final, o más pares nombre/valor"],
    ["LAMBDA", "LAMBDA", "Crea una función personalizada reutilizable.", "[parámetro1]...: Parámetros de la función | cálculo: Fórmula que se evalúa"],
  ],
  lookup: [
    ["VLOOKUP", "BUSCARV", "Busca un valor en la primera columna de una tabla y devuelve un valor de la misma fila en otra columna.", "valor_buscado: Valor que se busca en la primera columna | matriz_tabla: Tabla de datos | indicador_columnas: Número de columna que se devuelve (1 = primera) | [rango]: FALSO = coincidencia exacta; VERDADERO u omitido = aproximada"],
    ["HLOOKUP", "BUSCARH", "Busca un valor en la primera fila de una tabla y devuelve un valor de la misma columna en otra fila.", "valor_buscado: Valor que se busca en la primera fila | matriz_tabla: Tabla de datos | indicador_filas: Número de fila que se devuelve | [rango]: FALSO = coincidencia exacta"],
    ["XLOOKUP", "BUSCARX", "Busca un valor en un rango y devuelve el elemento correspondiente de otro rango.", "valor_buscado: Valor que se busca | matriz_buscada: Rango donde se busca | matriz_devuelta: Rango que se devuelve | [si_no_se_encuentra]: Valor si no hay coincidencia | [modo_de_coincidencia]: 0 = exacta, -1 = exacta o menor, 1 = exacta o mayor, 2 = comodín | [modo_de_búsqueda]: 1 = del primero al último, -1 = del último al primero"],
    ["LOOKUP", "BUSCAR", "Busca un valor en un rango de una fila o columna.", "valor_buscado: Valor que se busca | vector_de_comparación: Rango de búsqueda | [vector_resultado]: Rango de resultados"],
    ["INDEX", "INDICE", "Devuelve el valor de una celda en la intersección de una fila y una columna de un rango.", "matriz: Rango de celdas | núm_fila: Fila del rango | [núm_columna]: Columna del rango"],
    ["MATCH", "COINCIDIR", "Devuelve la posición relativa de un elemento en un rango.", "valor_buscado: Valor que se busca | matriz_buscada: Rango de búsqueda | [tipo_de_coincidencia]: 0 = exacta, 1 = menor o igual, -1 = mayor o igual"],
    ["XMATCH", "COINCIDIRX", "Devuelve la posición relativa de un elemento en un rango.", "valor_buscado: Valor que se busca | matriz_buscada: Rango de búsqueda | [modo_de_coincidencia]: 0 = exacta, -1, 1, 2 = comodín | [modo_de_búsqueda]: 1, -1, 2, -2"],
    ["CHOOSE", "ELEGIR", "Elige un valor de una lista según un número de índice.", "núm_índice: Posición del valor (1 a 254) | valor1: Primer valor | [valor2]...: Valores adicionales"],
    ["OFFSET", "DESREF", "Devuelve una referencia desplazada un número de filas y columnas desde una referencia dada.", "ref: Referencia de partida | filas: Filas que se desplaza | columnas: Columnas que se desplaza | [alto]: Alto en filas | [ancho]: Ancho en columnas"],
    ["INDIRECT", "INDIRECTO", "Devuelve la referencia especificada por un texto.", "ref: Texto con la referencia (p. ej. \"B2\") | [a1]: VERDADERO u omitido = estilo A1"],
    ["ROW", "FILA", "Devuelve el número de fila de una referencia.", "[ref]: Celda o rango; si se omite, la celda de la fórmula"],
    ["ROWS", "FILAS", "Devuelve el número de filas de una referencia o matriz.", "matriz: Rango o matriz"],
    ["COLUMN", "COLUMNA", "Devuelve el número de columna de una referencia.", "[ref]: Celda o rango; si se omite, la celda de la fórmula"],
    ["COLUMNS", "COLUMNAS", "Devuelve el número de columnas de una referencia o matriz.", "matriz: Rango o matriz"],
    ["ADDRESS", "DIRECCION", "Crea una referencia de celda en forma de texto.", "fila: Número de fila | columna: Número de columna | [abs]: Tipo de referencia (1 = absoluta) | [a1]: Estilo A1 | [hoja]: Nombre de la hoja"],
    ["TRANSPOSE", "TRANSPONER", "Convierte un rango vertical en horizontal o viceversa.", "matriz: Rango o matriz que se transpone"],
    ["HYPERLINK", "HIPERVINCULO", "Crea un vínculo que abre un documento o página web.", "ubicación_del_vínculo: Ruta o URL | [nombre_descriptivo]: Texto que se muestra"],
  ],
  array: [
    ["FILTER", "FILTRAR", "Filtra un rango según los criterios que defina.", "matriz: Rango que se filtra | incluir: Matriz de VERDADERO/FALSO del mismo alto o ancho | [si_está_vacío]: Valor si no hay resultados"],
    ["SORT", "ORDENAR", "Ordena el contenido de un rango o matriz.", "matriz: Rango que se ordena | [índice_de_orden]: Fila o columna por la que se ordena | [orden_de_ordenación]: 1 = ascendente, -1 = descendente | [por_columna]: VERDADERO ordena por columnas"],
    ["SORTBY", "ORDENARPOR", "Ordena un rango según los valores de otro rango.", "matriz: Rango que se ordena | por_matriz1: Rango por el que se ordena | [orden_de_ordenación1]: 1 = ascendente, -1 = descendente | [por_matriz2]...: Criterios adicionales, por pares"],
    ["UNIQUE", "UNICOS", "Devuelve los valores únicos de un rango.", "matriz: Rango de origen | [por_columna]: VERDADERO compara columnas | [exactamente_una_vez]: VERDADERO devuelve los que aparecen una sola vez"],
    ["SEQUENCE", "SECUENCIA", "Genera una lista de números secuenciales.", "filas: Número de filas | [columnas]: Número de columnas | [inicio]: Primer número | [incremento]: Incremento"],
    ["TAKE", "TOMAR", "Devuelve filas o columnas del principio o final de una matriz.", "matriz: Matriz de origen | filas: Filas que se toman (negativo = desde el final) | [columnas]: Columnas que se toman"],
    ["DROP", "EXCLUIR", "Quita filas o columnas del principio o final de una matriz.", "matriz: Matriz de origen | filas: Filas que se quitan | [columnas]: Columnas que se quitan"],
    ["VSTACK", "APILARV", "Apila matrices verticalmente.", "matriz1: Primera matriz | [matriz2]...: Matrices adicionales"],
    ["HSTACK", "APILARH", "Apila matrices horizontalmente.", "matriz1: Primera matriz | [matriz2]...: Matrices adicionales"],
    ["CHOOSECOLS", "ELEGIRCOLS", "Devuelve las columnas especificadas de una matriz.", "matriz: Matriz de origen | núm_col1: Primera columna | [núm_col2]...: Columnas adicionales"],
    ["CHOOSEROWS", "ELEGIRFILAS", "Devuelve las filas especificadas de una matriz.", "matriz: Matriz de origen | núm_fila1: Primera fila | [núm_fila2]...: Filas adicionales"],
    ["TOCOL", "ENCOL", "Devuelve la matriz en una sola columna.", "matriz: Matriz de origen | [ignorar]: 1 = vacías, 2 = errores, 3 = ambos | [por_columna]: VERDADERO recorre por columnas"],
    ["TOROW", "ENFILA", "Devuelve la matriz en una sola fila.", "matriz: Matriz de origen | [ignorar]: 1 = vacías, 2 = errores, 3 = ambos | [por_columna]: VERDADERO recorre por columnas"],
    ["WRAPROWS", "AJUSTARFILAS", "Ajusta un vector en filas de un ancho dado.", "vector: Fila o columna | recuento_de_ajuste: Valores por fila | [rellenar_con]: Valor de relleno"],
    ["WRAPCOLS", "AJUSTARCOLS", "Ajusta un vector en columnas de un alto dado.", "vector: Fila o columna | recuento_de_ajuste: Valores por columna | [rellenar_con]: Valor de relleno"],
    ["EXPAND", "EXPANDIR", "Expande una matriz a las dimensiones indicadas.", "matriz: Matriz de origen | filas: Filas totales | [columnas]: Columnas totales | [rellenar_con]: Valor de relleno"],
  ],
  text: [
    ["LEFT", "IZQUIERDA", "Devuelve los primeros caracteres de un texto.", "texto: Texto de origen | [núm_de_caracteres]: Caracteres que se extraen (1 por defecto)"],
    ["RIGHT", "DERECHA", "Devuelve los últimos caracteres de un texto.", "texto: Texto de origen | [núm_de_caracteres]: Caracteres que se extraen (1 por defecto)"],
    ["MID", "EXTRAE", "Devuelve los caracteres del centro de un texto, dada una posición y longitud.", "texto: Texto de origen | posición_inicial: Posición del primer carácter (1 = primero) | núm_de_caracteres: Caracteres que se extraen"],
    ["LEN", "LARGO", "Devuelve el número de caracteres de un texto.", "texto: Texto cuya longitud se calcula"],
    ["FIND", "ENCONTRAR", "Devuelve la posición de un texto dentro de otro (distingue mayúsculas).", "texto_buscado: Texto que se busca | dentro_del_texto: Texto donde se busca | [núm_inicial]: Posición desde la que se busca"],
    ["SEARCH", "HALLAR", "Devuelve la posición de un texto dentro de otro (no distingue mayúsculas; admite comodines).", "texto_buscado: Texto que se busca | dentro_del_texto: Texto donde se busca | [núm_inicial]: Posición desde la que se busca"],
    ["SUBSTITUTE", "SUSTITUIR", "Reemplaza un texto por otro dentro de una cadena.", "texto: Texto de origen | texto_original: Texto que se reemplaza | texto_nuevo: Texto de reemplazo | [núm_de_instancia]: Qué aparición se reemplaza (todas si se omite)"],
    ["REPLACE", "REEMPLAZAR", "Reemplaza parte de un texto según la posición.", "texto_original: Texto de origen | núm_inicial: Posición inicial | núm_de_caracteres: Caracteres que se reemplazan | texto_nuevo: Texto de reemplazo"],
    ["TRIM", "ESPACIOS", "Quita los espacios del texto, salvo los espacios simples entre palabras.", "texto: Texto del que se quitan los espacios"],
    ["CLEAN", "LIMPIAR", "Quita del texto los caracteres no imprimibles.", "texto: Texto que se limpia"],
    ["UPPER", "MAYUSC", "Convierte un texto en mayúsculas.", "texto: Texto que se convierte"],
    ["LOWER", "MINUSC", "Convierte un texto en minúsculas.", "texto: Texto que se convierte"],
    ["PROPER", "NOMPROPIO", "Pone en mayúscula la primera letra de cada palabra.", "texto: Texto que se convierte"],
    ["TEXT", "TEXTO", "Convierte un valor en texto con el formato de número indicado.", "valor: Valor que se convierte | formato: Formato de número entre comillas (p. ej. \"0.00\")"],
    ["VALUE", "VALOR", "Convierte un texto que representa un número en un número.", "texto: Texto que se convierte"],
    ["NUMBERVALUE", "VALOR.NUMERO", "Convierte texto en número de forma independiente de la configuración regional.", "texto: Texto que se convierte | [separador_decimal]: Carácter decimal | [separador_grupo]: Carácter de miles"],
    ["CONCAT", "CONCAT", "Concatena una lista o rango de textos.", "texto1: Primer texto o rango | [texto2]...: Textos adicionales"],
    ["CONCATENATE", "CONCATENAR", "Une varios textos en uno solo.", "texto1: Primer texto | [texto2]...: Textos adicionales"],
    ["TEXTJOIN", "UNIRCADENAS", "Une textos con un delimitador.", "delimitador: Texto que se inserta entre elementos | ignorar_vacías: VERDADERO omite las celdas vacías | texto1: Primer texto o rango | [texto2]...: Textos adicionales"],
    ["TEXTBEFORE", "TEXTOANTES", "Devuelve el texto anterior a un delimitador.", "texto: Texto de origen | delimitador: Texto delimitador | [núm_instancia]: Qué aparición | [modo_coincidencia]: 1 = no distingue mayúsculas | [coincidencia_final]: Trata el final como delimitador | [si_no_se_encuentra]: Valor si no se encuentra"],
    ["TEXTAFTER", "TEXTODESPUES", "Devuelve el texto posterior a un delimitador.", "texto: Texto de origen | delimitador: Texto delimitador | [núm_instancia]: Qué aparición | [modo_coincidencia]: 1 = no distingue mayúsculas | [coincidencia_final]: Trata el final como delimitador | [si_no_se_encuentra]: Valor si no se encuentra"],
    ["TEXTSPLIT", "DIVIDIRTEXTO", "Divide un texto en filas o columnas según delimitadores.", "texto: Texto que se divide | delimitador_columna: Delimitador entre columnas | [delimitador_fila]: Delimitador entre filas | [ignorar_vacías]: VERDADERO omite vacíos | [modo_coincidencia]: 1 = no distingue mayúsculas | [rellenar_con]: Valor de relleno"],
    ["REPT", "REPETIR", "Repite un texto un número determinado de veces.", "texto: Texto que se repite | núm_de_veces: Número de repeticiones"],
    ["EXACT", "IGUAL", "Comprueba si dos textos son exactamente iguales.", "texto1: Primer texto | texto2: Segundo texto"],
    ["CHAR", "CARACTER", "Devuelve el carácter especificado por un número de código.", "número: Código entre 1 y 255"],
    ["UNICHAR", "UNICAR", "Devuelve el carácter Unicode de un valor numérico.", "número: Código Unicode"],
    ["CODE", "CODIGO", "Devuelve el código numérico del primer carácter de un texto.", "texto: Texto de origen"],
    ["FIXED", "DECIMAL", "Redondea un número y lo devuelve como texto con decimales fijos.", "número: Número que se redondea | [decimales]: Número de decimales | [no_separar_millares]: VERDADERO omite los separadores de miles"],
    ["T", "T", "Devuelve el texto al que se refiere un valor, o texto vacío si no es texto.", "valor: Valor que se comprueba"],
  ],
  date: [
    ["TODAY", "HOY", "Devuelve la fecha actual.", ""],
    ["NOW", "AHORA", "Devuelve la fecha y hora actuales.", ""],
    ["DATE", "FECHA", "Devuelve el número de serie de una fecha.", "año: Año (1900-9999) | mes: Mes (1-12) | día: Día del mes"],
    ["TIME", "NSHORA", "Devuelve el número de serie de una hora.", "hora: Hora (0-23) | minuto: Minuto (0-59) | segundo: Segundo (0-59)"],
    ["YEAR", "AÑO", "Devuelve el año de una fecha.", "núm_de_serie: Fecha"],
    ["MONTH", "MES", "Devuelve el mes de una fecha (1-12).", "núm_de_serie: Fecha"],
    ["DAY", "DIA", "Devuelve el día del mes de una fecha (1-31).", "núm_de_serie: Fecha"],
    ["HOUR", "HORA", "Devuelve la hora de un valor de hora (0-23).", "núm_de_serie: Hora"],
    ["MINUTE", "MINUTO", "Devuelve el minuto de un valor de hora (0-59).", "núm_de_serie: Hora"],
    ["SECOND", "SEGUNDO", "Devuelve el segundo de un valor de hora (0-59).", "núm_de_serie: Hora"],
    ["WEEKDAY", "DIASEM", "Devuelve el día de la semana de una fecha.", "núm_de_serie: Fecha | [tipo]: 1 = domingo a sábado (1-7), 2 = lunes a domingo (1-7), 3 = lunes a domingo (0-6)"],
    ["WEEKNUM", "NUM.DE.SEMANA", "Devuelve el número de semana del año.", "núm_de_serie: Fecha | [tipo]: Día en que empieza la semana (1 = domingo, 2 = lunes, 21 = ISO)"],
    ["ISOWEEKNUM", "ISO.NUM.DE.SEMANA", "Devuelve el número de semana ISO del año.", "fecha: Fecha"],
    ["EDATE", "FECHA.MES", "Devuelve la fecha que está un número de meses antes o después de una fecha.", "fecha_inicial: Fecha de partida | meses: Meses que se suman (negativo para restar)"],
    ["EOMONTH", "FIN.MES", "Devuelve el último día del mes, un número de meses antes o después.", "fecha_inicial: Fecha de partida | meses: Meses que se suman (0 = mes actual)"],
    ["DATEDIF", "SIFECHA", "Calcula la diferencia entre dos fechas en días, meses o años.", "fecha_inicial: Fecha de inicio | fecha_final: Fecha de fin | unidad: \"Y\" años, \"M\" meses, \"D\" días, \"MD\", \"YM\", \"YD\""],
    ["DATEVALUE", "FECHANUMERO", "Convierte una fecha en forma de texto en un número de serie.", "texto_de_fecha: Texto con una fecha"],
    ["TIMEVALUE", "HORANUMERO", "Convierte una hora en forma de texto en un número de serie.", "texto_de_hora: Texto con una hora"],
    ["NETWORKDAYS", "DIAS.LAB", "Devuelve el número de días laborables entre dos fechas.", "fecha_inicial: Fecha de inicio | fecha_final: Fecha de fin | [vacaciones]: Fechas festivas que se excluyen"],
    ["NETWORKDAYS.INTL", "DIAS.LAB.INTL", "Devuelve los días laborables entre dos fechas con fines de semana personalizados.", "fecha_inicial: Fecha de inicio | fecha_final: Fecha de fin | [fin_de_semana]: Código o patrón de fin de semana | [vacaciones]: Fechas festivas"],
    ["WORKDAY", "DIA.LAB", "Devuelve la fecha tras un número de días laborables.", "fecha_inicial: Fecha de partida | días: Días laborables | [vacaciones]: Fechas festivas que se excluyen"],
    ["WORKDAY.INTL", "DIA.LAB.INTL", "Devuelve la fecha tras un número de días laborables con fines de semana personalizados.", "fecha_inicial: Fecha de partida | días: Días laborables | [fin_de_semana]: Código o patrón de fin de semana | [vacaciones]: Fechas festivas"],
    ["YEARFRAC", "FRAC.AÑO", "Devuelve la fracción de año entre dos fechas.", "fecha_inicial: Fecha de inicio | fecha_final: Fecha de fin | [base]: Base de recuento de días (0-4)"],
    ["DAYS", "DIAS", "Devuelve el número de días entre dos fechas.", "fecha_final: Fecha de fin | fecha_inicial: Fecha de inicio"],
    ["DAYS360", "DIAS360", "Calcula los días entre dos fechas con un año de 360 días.", "fecha_inicial: Fecha de inicio | fecha_final: Fecha de fin | [método]: FALSO = EE. UU., VERDADERO = europeo"],
  ],
  financial: [
    ["PMT", "PAGO", "Calcula el pago de un préstamo con pagos y tasa de interés constantes.", "tasa: Tasa de interés por período | nper: Número total de pagos | va: Valor actual (importe del préstamo) | [vf]: Valor futuro | [tipo]: 0 = al final del período, 1 = al inicio"],
    ["PPMT", "PAGOPRIN", "Devuelve el pago de capital de un período dado.", "tasa: Tasa por período | período: Período (1 a nper) | nper: Número total de pagos | va: Valor actual | [vf]: Valor futuro | [tipo]: 0 = final, 1 = inicio"],
    ["IPMT", "PAGOINT", "Devuelve el pago de intereses de un período dado.", "tasa: Tasa por período | período: Período (1 a nper) | nper: Número total de pagos | va: Valor actual | [vf]: Valor futuro | [tipo]: 0 = final, 1 = inicio"],
    ["CUMIPMT", "PAGO.INT.ENTRE", "Devuelve el interés acumulado pagado entre dos períodos.", "tasa: Tasa por período | nper: Número total de pagos | va: Valor actual | período_inicial: Primer período | período_final: Último período | tipo: 0 = final, 1 = inicio"],
    ["CUMPRINC", "PAGO.PRINC.ENTRE", "Devuelve el capital acumulado pagado entre dos períodos.", "tasa: Tasa por período | nper: Número total de pagos | va: Valor actual | período_inicial: Primer período | período_final: Último período | tipo: 0 = final, 1 = inicio"],
    ["NPV", "VNA", "Calcula el valor neto actual de una inversión a partir de una tasa de descuento y flujos periódicos.", "tasa: Tasa de descuento por período | valor1: Primer flujo o rango | [valor2]...: Flujos adicionales"],
    ["XNPV", "VNA.NO.PER", "Devuelve el valor neto actual de flujos no periódicos.", "tasa: Tasa de descuento anual | valores: Flujos de caja | fechas: Fechas de los flujos"],
    ["IRR", "TIR", "Devuelve la tasa interna de retorno de una serie de flujos periódicos.", "valores: Flujos de caja (al menos uno negativo y uno positivo) | [estimar]: Estimación inicial"],
    ["XIRR", "TIR.NO.PER", "Devuelve la tasa interna de retorno de flujos no periódicos.", "valores: Flujos de caja | fechas: Fechas de los flujos | [estimar]: Estimación inicial"],
    ["MIRR", "TIRM", "Devuelve la tasa interna de retorno modificada.", "valores: Flujos de caja | tasa_financiación: Tasa de los préstamos | tasa_reinversión: Tasa de reinversión"],
    ["FV", "VF", "Devuelve el valor futuro de una inversión.", "tasa: Tasa por período | nper: Número de períodos | pago: Pago por período | [va]: Valor actual | [tipo]: 0 = final, 1 = inicio"],
    ["PV", "VA", "Devuelve el valor actual de una inversión.", "tasa: Tasa por período | nper: Número de períodos | pago: Pago por período | [vf]: Valor futuro | [tipo]: 0 = final, 1 = inicio"],
    ["RATE", "TASA", "Devuelve la tasa de interés por período de un préstamo o inversión.", "nper: Número de períodos | pago: Pago por período | va: Valor actual | [vf]: Valor futuro | [tipo]: 0 = final, 1 = inicio | [estimar]: Estimación inicial"],
    ["NPER", "NPER", "Devuelve el número de períodos de una inversión.", "tasa: Tasa por período | pago: Pago por período | va: Valor actual | [vf]: Valor futuro | [tipo]: 0 = final, 1 = inicio"],
    ["EFFECT", "INT.EFECTIVO", "Devuelve la tasa de interés anual efectiva.", "int_nominal: Tasa nominal | núm_por_año: Períodos de capitalización por año"],
    ["NOMINAL", "TASA.NOMINAL", "Devuelve la tasa de interés nominal anual.", "tasa_efectiva: Tasa efectiva | núm_por_año: Períodos de capitalización por año"],
    ["SLN", "SLN", "Devuelve la amortización lineal de un bien en un período.", "costo: Costo inicial | valor_residual: Valor al final de la vida útil | vida: Número de períodos de vida útil"],
    ["DB", "DB", "Devuelve la amortización de un bien por el método de saldo fijo decreciente.", "costo: Costo inicial | valor_residual: Valor residual | vida: Vida útil | período: Período | [mes]: Meses del primer año"],
    ["DDB", "DDB", "Devuelve la amortización por el método de doble saldo decreciente.", "costo: Costo inicial | valor_residual: Valor residual | vida: Vida útil | período: Período | [factor]: Tasa de disminución (2 por defecto)"],
    ["SYD", "SYD", "Devuelve la amortización por el método de suma de dígitos de los años.", "costo: Costo inicial | valor_residual: Valor residual | vida: Vida útil | período: Período"],
  ],
  info: [
    ["ISBLANK", "ESBLANCO", "Comprueba si una celda está vacía.", "valor: Celda que se comprueba"],
    ["ISNUMBER", "ESNUMERO", "Comprueba si un valor es un número.", "valor: Valor que se comprueba"],
    ["ISTEXT", "ESTEXTO", "Comprueba si un valor es texto.", "valor: Valor que se comprueba"],
    ["ISNONTEXT", "ESNOTEXTO", "Comprueba si un valor no es texto.", "valor: Valor que se comprueba"],
    ["ISLOGICAL", "ESLOGICO", "Comprueba si un valor es lógico (VERDADERO o FALSO).", "valor: Valor que se comprueba"],
    ["ISERROR", "ESERROR", "Comprueba si un valor es cualquier error.", "valor: Valor que se comprueba"],
    ["ISERR", "ESERR", "Comprueba si un valor es un error distinto de #N/A.", "valor: Valor que se comprueba"],
    ["ISNA", "ESNOD", "Comprueba si un valor es el error #N/A.", "valor: Valor que se comprueba"],
    ["ISEVEN", "ES.PAR", "Comprueba si un número es par.", "número: Valor que se comprueba"],
    ["ISODD", "ES.IMPAR", "Comprueba si un número es impar.", "número: Valor que se comprueba"],
    ["ISFORMULA", "ESFORMULA", "Comprueba si una celda contiene una fórmula.", "referencia: Celda que se comprueba"],
    ["ISREF", "ESREF", "Comprueba si un valor es una referencia.", "valor: Valor que se comprueba"],
    ["NA", "NOD", "Devuelve el valor de error #N/A.", ""],
    ["N", "N", "Convierte un valor en número.", "valor: Valor que se convierte"],
    ["TYPE", "TIPO", "Devuelve un número que indica el tipo de datos de un valor.", "valor: Valor que se comprueba"],
    ["ERROR.TYPE", "TIPO.DE.ERROR", "Devuelve un número que corresponde a un tipo de error.", "valor_de_error: Valor de error"],
  ],
};

export const FUNCTIONS: ReadonlyArray<FunctionInfo> = (Object.keys(RAW) as FunctionCategory[]).flatMap((category) =>
  RAW[category].map(([name, es, description, args]) => ({ name, es, category, description, args: parseArgs(args) })),
);

const BY_NAME = new Map<string, FunctionInfo>(FUNCTIONS.map((f) => [f.name, f]));

/** Catalog entry by en-US name (case-insensitive, tolerates the `_xlfn.` prefix). */
export function getFunctionInfo(name: string): FunctionInfo | undefined {
  const upper = name.toUpperCase();
  return BY_NAME.get(upper.startsWith("_XLFN.") ? upper.slice(6) : upper);
}

/** Placeholder entry for engine functions missing from the catalog. */
export function genericFunctionInfo(name: string): FunctionInfo {
  return { name: name.toUpperCase(), es: "", category: "math", description: "", args: [] };
}

/** Signature as text: `SUMIF(rango, criterio, [rango_suma])`. */
export function formatSignature(fn: FunctionInfo): string {
  return `${fn.name}(${fn.args.map((a) => argLabel(a)).join(", ")})`;
}

export function argLabel(arg: FunctionArg): string {
  const base = arg.repeating ? `${arg.name}...` : arg.name;
  return arg.optional ? `[${base}]` : base;
}

/**
 * Catalog argument for a 0-based argument index, following repeating groups:
 * for `SUMIFS(rango_suma, rango_criterios1, criterio1, [rango_criterios2]...)`
 * index 3 → `rango_criterios2`, 4 → `criterio2`, 5 → `rango_criterios3`…
 * `position` is the index of the catalog arg to highlight in the signature.
 */
export function argForIndex(fn: FunctionInfo, index: number): { arg: FunctionArg; position: number } | null {
  const args = fn.args;
  if (index < 0 || args.length === 0) return null;
  if (index < args.length) return { arg: args[index], position: index };
  const repeatAt = args.findIndex((a) => a.repeating);
  if (repeatAt < 0) return null;
  // The repeating arg (`rango_criterios2`) continues the group that starts at
  // the arg with the same stem numbered 1 (`rango_criterios1`).
  const stemOf = (name: string) => name.replace(/\d+$/, "");
  const stem = stemOf(args[repeatAt].name);
  const groupStart = args.findIndex((a, k) => k < repeatAt && stemOf(a.name) === stem && /1$/.test(a.name));
  if (groupStart < 0) return { arg: args[repeatAt], position: repeatAt };
  const groupSize = repeatAt - groupStart;
  const offset = (index - groupStart) % groupSize;
  const n = Math.floor((index - groupStart) / groupSize) + 1;
  const template = args[groupStart + offset];
  return {
    arg: { ...template, name: `${stemOf(template.name)}${n}`, optional: true, repeating: false },
    position: repeatAt,
  };
}
