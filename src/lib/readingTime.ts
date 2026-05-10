/**
 * Calcula tempo de leitura em minutos com base na contagem de palavras.
 * Usa 200 palavras/min (média padrão pra leitor adulto em PT-BR).
 * Retorna no mínimo 1 minuto.
 */
const WORDS_PER_MINUTE = 200;

function countWords(text: string): number {
    if (!text) return 0;
    const stripped = text
        .replace(/<[^>]+>/g, ' ')      // remove tags HTML
        .replace(/\s+/g, ' ')           // colapsa whitespace
        .trim();
    if (!stripped) return 0;
    return stripped.split(/\s+/).length;
}

export function readingTime(input: any): number {
    if (!input) return 1;
    let text = '';
    if (typeof input === 'string') {
        text = input;
    } else if (input.body) {
        text = String(input.body);
    } else if (input.data?.body) {
        text = String(input.data.body);
    }
    const words = countWords(text);
    const minutes = Math.max(1, Math.round(words / WORDS_PER_MINUTE));
    return minutes;
}

export function readingTimeLabel(input: any): string {
    const m = readingTime(input);
    return `${m} min de leitura`;
}
