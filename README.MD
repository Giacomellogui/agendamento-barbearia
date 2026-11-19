# Agendamento de Barbearia

Sistema de agendamento com uma área para clientes e um painel administrativo
para o barbeiro. O cadastro de contas, as reservas, o catálogo de serviços e
o expediente são salvos no SQLite.

## Funcionalidades

### Área do cliente

- Cadastro com nome completo, telefone com DDD, senha e e-mail de recuperação opcional. A entrada usa telefone e senha.
- Recuperação de senha por e-mail verificado, com link de uso único válido por 15 minutos.
- Escolha de serviço, data em calendário e horário disponível. O preço aparece quando cadastrado.
- Aba **Minha agenda** com **Próximos agendamentos** em ordem de horário e **Histórico** de reservas passadas ou canceladas.
- Cancelamento e reagendamento de reservas futuras pela própria conta. O reagendamento mantém a duração do serviço e libera o horário anterior.

### Painel do barbeiro

- Acesso com a senha definida em `BARBEIRO_SENHA`.
- Agenda por data, com nome do cliente, serviço, horário e telefone quando disponível.
- Cancelamento com liberação do horário e registro no histórico do cliente.
- Reagendamento de reservas futuras pelo painel, respeitando as mesmas regras de disponibilidade da área do cliente.
- Registro de **Concluído** ou **Falta** após o fim do atendimento. O resultado aparece no histórico do cliente e pode ser corrigido pelo barbeiro.
- Configuração dos dias de atendimento, da abertura, do fechamento e da pausa para almoço.
- Bloqueios por data para fechar o dia inteiro ou um intervalo. Selecione o dia na agenda e abra **Bloqueios por data**. O painel mostra as reservas afetadas antes de salvar, e elas continuam na agenda.
- Cadastro e edição de serviços, com nome, duração e preço opcional.
- Aviso de reagendamento por WhatsApp quando a integração estiver configurada.
- Consulta dos 30 avisos mais recentes em **Avisos do WhatsApp**, com estado **Pendente**, **Aceito pela Meta** ou **Falha**.

O sistema verifica o expediente, a duração do serviço e os conflitos antes de
salvar uma reserva. O agendamento e o painel oferecem temas claro e escuro.

## Capturas de tela

### Agendamento

![Calendário e seleção de horários na área do cliente](docs/agendamento.png)

### Minha agenda

![Próximos agendamentos e histórico da conta de demonstração](docs/minha-agenda.png)

### Painel do barbeiro

![Painel do barbeiro com a lista de reservas](docs/painel.png)

## Tecnologias

TypeScript, HTML, CSS, Node.js e SQLite.

## Como rodar

Use o Node.js 26, a versão usada para testar o projeto. Execute os comandos abaixo no PowerShell.

```powershell
npm.cmd install
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
```

Abra o arquivo `.env` na raiz do projeto, preencha `BARBEIRO_SENHA` e rode
`npm.cmd start`. O comando carrega o arquivo automaticamente. Se você já tem
um `.env`, edite o arquivo existente. Variáveis definidas no terminal têm
prioridade sobre os valores do arquivo.

- [Área do cliente](http://127.0.0.1:3000/) — abre no login quando não há sessão ativa.
- [Cadastro de cliente](http://127.0.0.1:3000/cliente/cadastro)
- [Painel do barbeiro](http://127.0.0.1:3000/painel)

O comando `npm.cmd start` compila o TypeScript do navegador e inicia o servidor.
O SQLite cria o arquivo local `agenda.sqlite` na pasta do projeto.
O Git ignora o `.env` e o banco local. O `.env.example` lista as opções de configuração.

## Fluxos do painel

- **Reagendar**. Na agenda do dia, abra uma reserva futura, escolha a nova data
  e o horário e salve. A reserva é atualizada na área do cliente.
- **Registrar comparecimento**. Depois do fim do horário, selecione **Concluído**
  ou **Falta** na reserva. Use **Sem registro** para limpar essa informação.
- **Bloquear um período**. Escolha a data na agenda, abra **Bloqueios por data**
  e clique em **Revisar bloqueio**. Se houver reservas no intervalo, confira
  a lista antes de confirmar. Você pode reagendá-las pelo painel.

## Avisos de reagendamento pelo WhatsApp

Configure um número remetente no WhatsApp Business Platform e um modelo aprovado pela Meta em português do Brasil (`pt_BR`). O corpo do modelo deve ter três parâmetros posicionais, nesta ordem: número da reserva, horário anterior e novo horário. Por exemplo:

> A reserva {{1}} foi reagendada. Horário anterior: {{2}}. Novo horário: {{3}}.

Preencha as variáveis no `.env` local:

```dotenv
WHATSAPP_TOKEN=token-de-acesso-da-meta
WHATSAPP_PHONE_NUMBER_ID=id-do-numero-remetente
WHATSAPP_BARBEIRO_NUMERO=5511987654321
WHATSAPP_TEMPLATE=reagendamento_barbearia
# Opcional. Use uma versão da Graph API compatível com a conta.
WHATSAPP_GRAPH_VERSION=v27.0
```

Informe o número do barbeiro com código do país e DDD, usando apenas dígitos. Se estiver usando um número de teste da Meta, inclua o barbeiro entre os destinatários permitidos.

Quando o cliente reagenda, a mudança é salva antes do envio. Com a integração configurada, os avisos entram numa fila no SQLite e o servidor tenta novamente após uma falha. O texto contém o número da reserva e os horários, sem o nome ou o telefone do cliente. Quando o barbeiro reagenda pelo painel, a mudança aparece na agenda do cliente. Sem as credenciais, o cliente ainda consegue reagendar normalmente.

Abra **Avisos do WhatsApp** no painel para consultar a fila e clique em **Atualizar avisos** para conferir novas tentativas. **Aceito pela Meta** significa que a API aceitou a solicitação. A entrega deve ser conferida no celular.

[Documentação do WhatsApp Business Platform](https://developers.facebook.com/documentation/business-messaging/whatsapp/overview)

## Recuperação de senha do cliente

O envio usa a API do Resend. Crie uma chave de envio e verifique o domínio que
vai aparecer no endereço remetente. Preencha o `.env`:

```dotenv
RESEND_API_KEY=sua-chave-do-resend
EMAIL_FROM="Barbearia <agenda@seu-dominio.com.br>"
APP_BASE_URL=http://127.0.0.1:3000
```

O endereço local serve para abrir os links no computador que executa o servidor.
Para abrir o link em outro dispositivo, configure `APP_BASE_URL` com o endereço
HTTPS onde o aplicativo estiver hospedado.

Para testar sem domínio próprio, use `EMAIL_FROM="Barbearia <onboarding@resend.dev>"`
e insira no cadastro o mesmo e-mail da sua conta Resend. Esse remetente só envia
mensagens de teste para o e-mail da conta. Para enviar a outros clientes, use
um remetente do seu domínio verificado.

1. Informe o endereço no cadastro para receber a confirmação. Se já tem conta,
   entre e abra **Minha conta → E-mail de recuperação** para informar o endereço
   e a senha atual.
2. Abra o link recebido e clique em **Confirmar e-mail**. O link vale por uma hora.
3. Na tela de login, clique em **Esqueci minha senha** e informe o e-mail confirmado.
4. Abra o link recebido e escolha uma nova senha. O link vale por 15 minutos e,
   após a troca, as sessões anteriores são encerradas. Para verificar a troca,
   entre novamente com o telefone e a senha nova.

Contas antigas também podem cadastrar o e-mail depois de entrar. A recuperação
usa somente o endereço já confirmado. Os avisos de reagendamento do barbeiro
continuam na integração com WhatsApp.

[Verificação de domínio no Resend](https://resend.com/docs/dashboard/domains/introduction)

## Código do servidor e testes

O `server.ts` inicia o servidor e serve as páginas. Os módulos em `servidor/`
tratam da autenticação, da agenda, do banco SQLite, das respostas HTTP e dos avisos.

Execute `npm.cmd test` para verificar pela API a disputa por horários, o acesso às
reservas, o reagendamento, o comparecimento, os bloqueios, o estado dos avisos
e a recuperação de senha.
A suíte usa um banco temporário e simula as respostas da Meta e do Resend.

## Teste manual

1. Crie uma conta de teste, entre e abra a área de agendamento em duas abas.
2. Nas duas abas, escolha o mesmo serviço, a mesma data e um horário livre. Confirme na primeira e tente confirmar na segunda sem recarregar. A segunda tentativa deve informar que o horário foi ocupado.
3. Em **Minha agenda → Próximos agendamentos**, clique em **Reagendar**, escolha outro horário e salve. O horário antigo deve ficar livre. Com a integração configurada, confira o aviso no celular do barbeiro.
4. Cancele a reserva pela conta do cliente. Ela deve aparecer no **Histórico** como **Cancelado**, e o último horário deve voltar à lista se ainda estiver dentro do expediente e no futuro.
