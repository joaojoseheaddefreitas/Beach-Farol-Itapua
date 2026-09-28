/**
 * ═══════════════════════════════════════════════════════════════════════
 * RADAR DE ENTREGA — geolocalização relativa em tempo real
 * ═══════════════════════════════════════════════════════════════════════
 *
 * Calcula, a partir da posição ao vivo do celular do atendente (Origem) e
 * da última posição capturada na mesa do cliente (Destino), o rumo e a
 * distância a percorrer — sem planta baixa, sem mapa 3D, sem calibração
 * manual de ambiente.
 *
 * DECISÕES DE ENGENHARIA (leia antes de usar):
 *
 * 1) A "macro-área" (Mezanino, Salão, Praia) NÃO é inferida por GPS.
 *    GPS não distingue andares nem sabe o layout do prédio — inferir
 *    isso a partir de latitude/longitude seria enganoso. Essa categoria
 *    é cadastrada UMA VEZ pelo estabelecimento, como um dado, não como
 *    um cálculo.
 *
 * 2) A direção que a seta aponta usa DUAS fontes, em camadas, porque
 *    nenhuma das duas é confiável sozinha o tempo todo:
 *      a) Bússola do aparelho (DeviceOrientationEvent / magnetômetro):
 *         funciona com o atendente parado, mas sofre interferência perto
 *         de metal, caixa de som, geladeira — comum em cozinha/balcão —
 *         e no iOS exige uma permissão extra pedida por gesto do usuário.
 *      b) Rumo de deslocamento por GPS (coords.heading): não sofre
 *         interferência magnética, mas só existe enquanto a pessoa está
 *         de fato andando (fica nulo parado).
 *    Se nenhuma das duas responder, o sistema NUNCA fica mudo: ele ainda
 *    informa a distância e a tendência (aproximando/afastando), que só
 *    depende de duas leituras de GPS e não falha.
 *
 * 3) O reposicionamento da mesa (grupo mudou de lugar / juntou-se a outra
 *    mesa, mantendo a mesma tag de QR) não precisa de lógica nova aqui:
 *    quem alimenta `atualizarAlvo()` é a camada de dados em tempo real
 *    (Supabase Realtime, no sistema atual), que já dispara a cada novo
 *    pedido/campainha naquele QR. Este módulo só recalcula no próximo
 *    quadro assim que uma posição nova chega — responsabilidade dele
 *    termina aí, de propósito, para não duplicar a camada de rede.
 * ═══════════════════════════════════════════════════════════════════════
 */

/**
 * ═══════════════════════════════════════════════════════════════════════
 * MÓDULO 1 — MAPEAMENTO PRÉVIO (vínculo de QR + metadados de uma vez só)
 * ═══════════════════════════════════════════════════════════════════════
 *
 * DECISÃO DE ARQUITETURA — por que NÃO existe "Direção Relativa" aqui:
 *
 * Uma direção fixa por mesa ("À Frente", "À Direita"...) só faz sentido
 * em relação a UM ponto de observação parado. O garçom anda pelo salão;
 * o que é "à frente" da mesa 5 muda a cada passo dele. Gravar isso uma
 * vez não descreve a realidade — precisaria ser recalculado a cada
 * posição do garçom, que é exatamente o que `RadarDeEntrega` (Módulo 2)
 * já faz sozinho, com o azimute real entre duas coordenadas de GPS.
 *
 * Além disso, tabelas em ambientes como praia mudam de lugar todo dia.
 * Uma direção escolhida manualmente teria que ser refeita a cada mudança,
 * mesa por mesa — exatamente o trabalho manual que este sistema existe
 * para eliminar. Por isso, aqui só entram três coisas que são feitas
 * UMA VEZ e continuam válidas mesmo que a mesa mude de posição:
 *
 *   1) Vínculo QR ↔ Número da mesa       (uma vez, quando a etiqueta é colada)
 *   2) Macroambiente (Superior/Inferior/Externa) (uma vez, o setor raramente muda)
 *   3) Âncora de referência, texto livre  (opcional, editável quando quiser)
 *
 * A posição exata (o "onde" de verdade) continua vindo do GPS capturado
 * automaticamente no pedido/campainha — não é cadastrada aqui.
 * ═══════════════════════════════════════════════════════════════════════
 */

/** Vínculo permanente entre a etiqueta física de QR e o número da mesa. */
export interface VinculoQR {
  numeroMesa: number;
  idQR: string;
  vinculadoEm: string; // ISO 8601
}

/** Uma frase curta e reutilizável ("Atrás do Coqueiro 1"), editável pelo estabelecimento. */
export interface AncoraRapida {
  id: string;
  texto: string;
}

/** O que o Módulo 1 produz e o Módulo 2 consome — sem nenhum ângulo/direção manual. */
export interface CadastroMesa {
  numeroMesa: number;
  idQR: string;
  macroArea: MacroArea;
  ancoraTexto?: string;
}

/**
 * PASSO 2 do fluxo pedido: abre a câmera e lê o QR físico da mesa.
 * Usa a API nativa `BarcodeDetector` (Chrome/Android). Ela NÃO existe no
 * Safari/iOS até o momento desta implementação — nesse caso, a função
 * lança um erro claro para a interface cair num campo de digitação manual
 * do ID do QR como alternativa, em vez de travar o cadastro.
 */
export async function escanearQRDaMesa(
  videoEl: HTMLVideoElement,
  timeoutMs = 15000
): Promise<string> {
  const BD = (window as any).BarcodeDetector;
  if (!BD) {
    throw new Error(
      "BarcodeDetector indisponível neste navegador (comum no Safari/iOS). " +
      "Use um campo de digitação manual do ID do QR como alternativa."
    );
  }
  const detector = new BD({ formats: ["qr_code"] });
  const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
  videoEl.srcObject = stream;
  await videoEl.play();

  const encerrarCamera = () => stream.getTracks().forEach((t) => t.stop());

  try {
    const inicio = Date.now();
    while (Date.now() - inicio < timeoutMs) {
      const codigos = await detector.detect(videoEl);
      if (codigos.length > 0) return codigos[0].rawValue as string;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error("Tempo esgotado sem ler nenhum QR — tente reposicionar a câmera.");
  } finally {
    encerrarCamera();
  }
}

/**
 * Fluxo completo dos 3 passos do Módulo 1, na ordem pedida:
 * número da mesa → vínculo do QR → macroárea + âncora opcional.
 * Cada passo grava progressivamente; o atendente pode interromper e
 * retomar sem perder o que já preencheu.
 */
export class CadastroDeMesaWizard {
  private numeroMesa: number | null = null;
  private idQR: string | null = null;
  private macroArea: MacroArea | null = null;
  private ancoraTexto?: string;

  definirNumero(numero: number): void {
    if (!Number.isInteger(numero) || numero <= 0) throw new Error("Número de mesa inválido.");
    this.numeroMesa = numero;
  }

  async vincularQR(videoEl: HTMLVideoElement): Promise<void> {
    if (this.numeroMesa == null) throw new Error("Defina o número da mesa antes de escanear o QR.");
    this.idQR = await escanearQRDaMesa(videoEl);
  }

  /** Alternativa ao scanner, para navegadores sem `BarcodeDetector` (ex.: Safari/iOS). */
  vincularQRManual(idQR: string): void {
    if (!idQR.trim()) throw new Error("ID do QR não pode ser vazio.");
    this.idQR = idQR.trim();
  }

  definirMacroArea(area: MacroArea): void {
    this.macroArea = area;
  }

  definirAncora(texto: string): void {
    this.ancoraTexto = texto.trim().slice(0, 60) || undefined;
  }

  finalizar(): CadastroMesa {
    if (this.numeroMesa == null) throw new Error("Falta o número da mesa.");
    if (!this.idQR) throw new Error("Falta vincular o QR Code.");
    if (!this.macroArea) throw new Error("Falta escolher o macroambiente.");
    return {
      numeroMesa: this.numeroMesa,
      idQR: this.idQR,
      macroArea: this.macroArea,
      ancoraTexto: this.ancoraTexto,
    };
  }
}

/** Lista de frases reutilizáveis por estabelecimento — evita redigitar toda vez. */
export class BibliotecaDeAncoras {
  constructor(private itens: AncoraRapida[] = []) {}

  listar(): readonly AncoraRapida[] { return this.itens; }

  adicionar(texto: string): AncoraRapida {
    const item: AncoraRapida = { id: crypto.randomUUID(), texto: texto.trim().slice(0, 60) };
    this.itens = [item, ...this.itens].slice(0, 30); // mantém a lista curta e útil
    return item;
  }

  remover(id: string): void {
    this.itens = this.itens.filter((i) => i.id !== id);
  }
}

// ─────────────────────────────────────────────────────────────────────
// TIPOS (continuação do Módulo 2, original)
// ─────────────────────────────────────────────────────────────────────


/** Um ponto no globo. */
export interface Coordenada {
  lat: number;
  lng: number;
}

/** Categoria fixa, cadastrada pelo estabelecimento — nunca inferida por GPS. */
export type MacroArea = "superior" | "inferior" | "externa";

export const MACRO_AREA_INFO: Record<MacroArea, { rotulo: string; cor: string }> = {
  superior: { rotulo: "MEZANINO / TERRAÇO", cor: "#8b5fbf" },
  inferior: { rotulo: "SALÃO INTERNO / TÉRREO", cor: "#2563eb" },
  externa: { rotulo: "PRAIA / DECK / ÁREA EXTERNA", cor: "#0d9488" },
};

/** Dados da mesa-alvo, vindos do backend (QR + última confirmação do cliente). */
export interface MesaAlvo {
  numero: number;
  macroArea: MacroArea;
  /** Texto curto opcional, cadastrado uma vez ("Atrás do coqueiro"). */
  zonaReferencia?: string;
  /** Última posição de GPS capturada no instante do pedido/campainha daquele QR. */
  posicao: Coordenada | null;
  /** Precisão (metros) que o celular do CLIENTE relatou ao capturar `posicao`. */
  precisaoMetros?: number;
}

/** De onde veio o rumo usado para girar a seta. */
export type FonteDirecao = "bussola" | "gps_em_movimento" | "indisponivel";

export type Tendencia = "aproximando" | "afastando" | "parado" | null;

/** Resultado pronto para a interface desenhar. */
export interface EstadoRadar {
  /** null enquanto não há a primeira leitura, ou quando o sinal está ruim demais para confiar. */
  distanciaMetros: number | null;
  /** -180..180°, 0 = reto à frente. null se não há fonte de direção. */
  anguloRelativoGraus: number | null;
  fonteDirecao: FonteDirecao;
  tendencia: Tendencia;
  /** true = mostrar seta/distância; false = mostrar só número da mesa + zona (sinal ruim, ex.: ambiente fechado). */
  sinalConfiavel: boolean;
  macroArea: MacroArea;
  zonaReferencia?: string;
}

export interface OpcoesRadar {
  /** Acima disso (metros de erro do GPS do atendente), não confiamos em seta/distância. Padrão: 20 m. */
  limitePrecisaoMetros?: number;
  /** Abaixo disso, consideramos "chegou". Padrão: 4 m. */
  raioChegadaMetros?: number;
}

// ─────────────────────────────────────────────────────────────────────
// GEOMETRIA PURA — sem estado, fácil de testar isoladamente
// ─────────────────────────────────────────────────────────────────────

const RAIO_TERRA_M = 6_371_000;
const GRAUS_PARA_RAD = Math.PI / 180;
const RAD_PARA_GRAUS = 180 / Math.PI;

/** Distância em metros entre dois pontos (fórmula de Haversine). */
export function distanciaMetros(a: Coordenada, b: Coordenada): number {
  const dLat = (b.lat - a.lat) * GRAUS_PARA_RAD;
  const dLng = (b.lng - a.lng) * GRAUS_PARA_RAD;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * GRAUS_PARA_RAD) * Math.cos(b.lat * GRAUS_PARA_RAD) * Math.sin(dLng / 2) ** 2;
  return 2 * RAIO_TERRA_M * Math.asin(Math.sqrt(h));
}

/** Azimute (rumo absoluto, 0–360°, 0 = Norte) do ponto A para o ponto B. */
export function azimuteGraus(a: Coordenada, b: Coordenada): number {
  const y = Math.sin((b.lng - a.lng) * GRAUS_PARA_RAD) * Math.cos(b.lat * GRAUS_PARA_RAD);
  const x =
    Math.cos(a.lat * GRAUS_PARA_RAD) * Math.sin(b.lat * GRAUS_PARA_RAD) -
    Math.sin(a.lat * GRAUS_PARA_RAD) * Math.cos(b.lat * GRAUS_PARA_RAD) * Math.cos((b.lng - a.lng) * GRAUS_PARA_RAD);
  return ((Math.atan2(y, x) * RAD_PARA_GRAUS) + 360) % 360;
}

/** Normaliza a diferença entre dois ângulos para o intervalo -180..180°. */
function anguloRelativo(azimuteAlvo: number, rumoAtual: number): number {
  return ((azimuteAlvo - rumoAtual + 540) % 360) - 180;
}

// ─────────────────────────────────────────────────────────────────────
// LEITURA DE SENSORES — cada fonte isolada na própria função,
// para poder trocar/testar uma sem mexer nas outras.
// ─────────────────────────────────────────────────────────────────────

/**
 * Pede permissão e liga a bússola do aparelho (magnetômetro).
 * Retorna uma função de "desligar". Chama `aoAtualizar(graus)` sempre que
 * o navegador reportar um novo heading absoluto (0 = Norte).
 *
 * iOS 13+ exige que `DeviceOrientationEvent.requestPermission()` seja
 * chamado dentro de um gesto do usuário (ex.: o toque em "Seguir até a
 * mesa") — por isso esta função é `async` e deve ser chamada a partir
 * de um handler de clique, não sozinha ao carregar a página.
 */
export async function ligarBussola(
  aoAtualizar: (headingGraus: number) => void,
  aoIndisponivel: () => void
): Promise<() => void> {
  const DOE = (window as any).DeviceOrientationEvent;
  if (!DOE) { aoIndisponivel(); return () => {}; }

  if (typeof DOE.requestPermission === "function") {
    try {
      const resposta = await DOE.requestPermission();
      if (resposta !== "granted") { aoIndisponivel(); return () => {}; }
    } catch {
      aoIndisponivel();
      return () => {};
    }
  }

  let recebeuAlgumaLeitura = false;
  const handler = (ev: DeviceOrientationEvent) => {
    // webkitCompassHeading (Safari/iOS) já vem como rumo absoluto em graus.
    // Em outros navegadores, usa-se `alpha` de um evento "absolute" --
    // sem garantia de precisão idêntica, mas suficiente para orientar
    // uma seta de "para que lado ir", que é o uso aqui.
    const compassIOS = (ev as any).webkitCompassHeading;
    const heading = typeof compassIOS === "number" ? compassIOS
      : (ev as any).absolute && ev.alpha != null ? (360 - ev.alpha) % 360
      : null;
    if (heading == null) return;
    recebeuAlgumaLeitura = true;
    aoAtualizar(heading);
  };

  window.addEventListener("deviceorientationabsolute" as any, handler, true);
  window.addEventListener("deviceorientation", handler, true);

  // Se em 2s nenhuma leitura chegou, o navegador não suporta de fato --
  // avisa o chamador para cair no plano B (GPS em movimento).
  const timeout = window.setTimeout(() => { if (!recebeuAlgumaLeitura) aoIndisponivel(); }, 2000);

  return () => {
    window.clearTimeout(timeout);
    window.removeEventListener("deviceorientationabsolute" as any, handler, true);
    window.removeEventListener("deviceorientation", handler, true);
  };
}

/**
 * Liga o GPS contínuo do atendente. Retorna uma função de "desligar".
 * `coords.heading` (rumo de deslocamento) só vem preenchido enquanto a
 * pessoa está de fato andando — é normal e esperado que venha `null`
 * com o aparelho parado.
 */
export function ligarGPS(
  aoAtualizar: (pos: Coordenada, precisaoMetros: number, headingGraus: number | null) => void,
  aoErro: (mensagem: string) => void
): () => void {
  if (!("geolocation" in navigator)) {
    aoErro("Este aparelho não tem GPS disponível.");
    return () => {};
  }
  const id = navigator.geolocation.watchPosition(
    (pos) => {
      const heading = pos.coords.heading != null && !Number.isNaN(pos.coords.heading) ? pos.coords.heading : null;
      aoAtualizar({ lat: pos.coords.latitude, lng: pos.coords.longitude }, pos.coords.accuracy, heading);
    },
    (err) => {
      aoErro(
        err.code === err.PERMISSION_DENIED
          ? "Localização bloqueada — permita o acesso para usar o guia."
          : "Não foi possível ler o GPS agora."
      );
    },
    { enableHighAccuracy: true, maximumAge: 1000 }
  );
  return () => navigator.geolocation.clearWatch(id);
}

// ─────────────────────────────────────────────────────────────────────
// ORQUESTRADOR — junta as fontes, decide o fallback, expõe o estado
// pronto para a tela desenhar.
// ─────────────────────────────────────────────────────────────────────

export class RadarDeEntrega {
  private alvo: MesaAlvo;
  private opcoes: Required<OpcoesRadar>;
  private ouvintes: Array<(estado: EstadoRadar) => void> = [];

  private minhaPosicao: Coordenada | null = null;
  private minhaPrecisao = Infinity;
  private headingGPS: number | null = null;
  private headingBussola: number | null = null;
  private bussolaDisponivel = true; // otimista até provar o contrário

  private distanciaAnterior: number | null = null;
  private desligarBussola: (() => void) | null = null;
  private desligarGPS: (() => void) | null = null;

  constructor(alvo: MesaAlvo, opcoes: OpcoesRadar = {}) {
    this.alvo = alvo;
    this.opcoes = {
      limitePrecisaoMetros: opcoes.limitePrecisaoMetros ?? 20,
      raioChegadaMetros: opcoes.raioChegadaMetros ?? 4,
    };
  }

  /** Assina atualizações de estado (chame antes de `iniciar()` para não perder o primeiro quadro). */
  aoMudar(callback: (estado: EstadoRadar) => void): void {
    this.ouvintes.push(callback);
  }

  /**
   * Liga bússola + GPS. Deve ser chamado a partir de um gesto do usuário
   * (ex.: onClick do botão "Seguir até a mesa"), por causa da permissão
   * de orientação exigida pelo iOS.
   */
  async iniciar(): Promise<void> {
    this.desligarBussola = await ligarBussola(
      (graus) => { this.headingBussola = graus; this.recalcular(); },
      () => { this.bussolaDisponivel = false; this.recalcular(); }
    );
    this.desligarGPS = ligarGPS(
      (pos, precisao, headingGPS) => {
        this.minhaPosicao = pos;
        this.minhaPrecisao = precisao;
        this.headingGPS = headingGPS;
        this.recalcular();
      },
      () => { /* erro de GPS: mantém último estado conhecido, não trava a tela */ }
    );
  }

  /**
   * Chame quando chegar uma posição nova do backend para esta mesma mesa
   * (mesmo QR, grupo mudou de lugar ou se juntou a outro). O recálculo
   * usa essa posição já no próximo quadro — não precisa reiniciar nada.
   */
  atualizarAlvo(novaPosicao: Coordenada | null, precisaoMetros?: number): void {
    this.alvo = { ...this.alvo, posicao: novaPosicao, precisaoMetros };
    this.recalcular();
  }

  parar(): void {
    this.desligarBussola?.();
    this.desligarGPS?.();
  }

  private recalcular(): void {
    const macroArea = this.alvo.macroArea;
    const zonaReferencia = this.alvo.zonaReferencia;

    if (!this.minhaPosicao || !this.alvo.posicao) {
      this.emitir({ distanciaMetros: null, anguloRelativoGraus: null, fonteDirecao: "indisponivel", tendencia: null, sinalConfiavel: false, macroArea, zonaReferencia });
      return;
    }

    // Sinal ruim (comum debaixo de teto): desliga sozinho seta/distância --
    // elas confundiriam mais do que ajudariam -- e devolve só a identidade
    // (mesa + zona), que vem do QR e nunca depende de GPS.
    const precisaoRelevante = Math.max(this.minhaPrecisao, this.alvo.precisaoMetros ?? 0);
    if (precisaoRelevante > this.opcoes.limitePrecisaoMetros) {
      this.emitir({ distanciaMetros: null, anguloRelativoGraus: null, fonteDirecao: "indisponivel", tendencia: null, sinalConfiavel: false, macroArea, zonaReferencia });
      return;
    }

    const dist = distanciaMetros(this.minhaPosicao, this.alvo.posicao);
    let tendencia: Tendencia = "parado";
    if (this.distanciaAnterior != null) {
      if (dist < this.distanciaAnterior - 1) tendencia = "aproximando";
      else if (dist > this.distanciaAnterior + 1) tendencia = "afastando";
    }
    this.distanciaAnterior = dist;

    const azimuteAlvo = azimuteGraus(this.minhaPosicao, this.alvo.posicao);

    // Prioridade 1: bússola (funciona parado). Prioridade 2: GPS andando.
    // Prioridade 3: nenhuma -- ainda assim entrega distância + tendência.
    let fonteDirecao: FonteDirecao = "indisponivel";
    let anguloRelativoGraus: number | null = null;
    if (this.bussolaDisponivel && this.headingBussola != null) {
      fonteDirecao = "bussola";
      anguloRelativoGraus = anguloRelativo(azimuteAlvo, this.headingBussola);
    } else if (this.headingGPS != null) {
      fonteDirecao = "gps_em_movimento";
      anguloRelativoGraus = anguloRelativo(azimuteAlvo, this.headingGPS);
    }

    this.emitir({
      distanciaMetros: dist <= this.opcoes.raioChegadaMetros ? 0 : dist,
      anguloRelativoGraus,
      fonteDirecao,
      tendencia,
      sinalConfiavel: true,
      macroArea,
      zonaReferencia,
    });
  }

  private emitir(estado: EstadoRadar): void {
    this.ouvintes.forEach((cb) => cb(estado));
  }
}
