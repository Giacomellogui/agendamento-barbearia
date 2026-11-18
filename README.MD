# Agendamento de Barbearia

Sistema de agendamento com uma área para clientes e um painel administrativo
para o barbeiro. O cadastro de contas, as reservas, o catálogo de serviços e
o expediente são salvos no SQLite.

## Funcionalidades

### Área do cliente

- Cadastro com nome completo, telefone com DDD e senha. A entrada usa telefone e senha.
- Escolha de serviço, data em calendário e horário disponível. O preço aparece quando cadastrado.
- Aba **Minha agenda** com as próprias reservas e seus estados **Agendado**, **Passado** ou **Cancelado**.

### Painel do barbeiro

- Acesso com a senha definida em `BARBEIRO_SENHA`.
- Agenda por data, com nome do cliente, serviço, horário e telefone quando disponível.
- Cancelamento com liberação do horário e registro no histórico do cliente.
- Configuração dos dias de atendimento, da abertura, do fechamento e da pausa para almoço.
- Cadastro e edição de serviços, com nome, duração e preço opcional.

O sistema verifica o expediente, a duração do serviço e os conflitos antes de
salvar uma reserva. O agendamento e o painel oferecem temas claro e escuro.

## Capturas de tela

Capturas de uma versão anterior do projeto.

### Agendamento

![Página de agendamento da barbearia](docs/agendamento.png)

### Painel do barbeiro

![Painel do barbeiro com a lista de reservas](docs/painel.png)

## Tecnologias

TypeScript, HTML, CSS, Node.js e SQLite.

## Como rodar

Use o Node.js 26, a versão usada para testar o projeto. Execute os comandos abaixo no PowerShell.

```powershell
npm.cmd install
$env:BARBEIRO_SENHA = 'escolha-sua-senha'
npm.cmd start
```

- [Área do cliente](http://127.0.0.1:3000/) — abre no login quando não há sessão ativa.
- [Cadastro de cliente](http://127.0.0.1:3000/cliente/cadastro)
- [Painel do barbeiro](http://127.0.0.1:3000/painel)

Substitua `escolha-sua-senha` pela senha que você quer usar no painel.
O comando `npm.cmd start` compila o TypeScript do navegador e inicia o servidor.
O SQLite cria o arquivo local `agenda.sqlite` na pasta do projeto.

## Teste manual

1. Crie uma conta de teste, entre e abra a área de agendamento em duas abas.
2. Nas duas abas, escolha o mesmo serviço, a mesma data e um horário livre. Confirme na primeira e tente confirmar na segunda sem recarregar. A segunda tentativa deve informar que o horário foi ocupado.
3. Abra **Minha agenda** e confira se a reserva aparece. No painel do barbeiro, consulte a mesma data e cancele a reserva.
4. Abra **Minha agenda** novamente. A reserva deve aparecer como **Cancelado**, e o horário deve voltar à lista se ainda estiver dentro do expediente e no futuro.
