export {};

// As duas telas usam a mesma chave de preferência no navegador.
const seletor = document.querySelector<HTMLSelectElement>("#tema");
const chave = "barbearia-tema";
const sistema = window.matchMedia("(prefers-color-scheme: dark)");

// Atualiza o atributo que controla a paleta no CSS.
function aplicarTema(tema: string | null) {
  const escolha = tema === "claro" || tema === "escuro" ? tema : "";
  document.documentElement.dataset.tema = escolha;
  if (seletor) seletor.value = escolha || (sistema.matches ? "escuro" : "claro");
}

// Na primeira visita, vale o tema do dispositivo.
let preferencia: string | null = null;
try {
  preferencia = localStorage.getItem(chave);
} catch {
  // A escolha ainda funciona na página quando o armazenamento está indisponível.
}

aplicarTema(preferencia);
sistema.addEventListener("change", () => aplicarTema(preferencia));

// Aplica a escolha e tenta guardá-la para as próximas visitas.
seletor?.addEventListener("change", () => {
  preferencia = seletor.value;
  aplicarTema(preferencia);
  try {
    localStorage.setItem(chave, preferencia);
  } catch {
    // A preferência continua aplicada nesta página.
  }
});

// Sincroniza a preferência quando ela muda em outra aba.
window.addEventListener("storage", (evento) => {
  if (evento.key === chave || evento.key === null) {
    preferencia = evento.newValue;
    aplicarTema(preferencia);
  }
});
