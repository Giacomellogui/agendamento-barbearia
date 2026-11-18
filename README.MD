# Agendamento de Barbearia

Sistema para clientes reservarem horários e para o barbeiro consultar
ou cancelar reservas em um painel protegido por senha.

## Funcionalidades

- Escolha de serviço, data e horário.
- Verificação de conflitos antes de salvar a reserva.
- Painel do barbeiro com login, consulta por data e cancelamento.

## Tecnologias

TypeScript, HTML, CSS, Node.js e SQLite.

## Como rodar

Use o Node.js 26, a versão usada para testar o projeto. Execute os comandos abaixo no PowerShell.

```powershell
npm.cmd install
$env:BARBEIRO_SENHA = 'escolha-sua-senha'
npm.cmd start
```

- [Página de agendamento](http://127.0.0.1:3000/)
- [Painel do barbeiro](http://127.0.0.1:3000/painel)

Substitua `escolha-sua-senha` pela senha que você quer usar no painel.
O comando `npm.cmd start` compila o TypeScript do navegador e inicia o servidor.
O SQLite cria o arquivo `agenda.sqlite` na pasta do projeto para guardar as reservas.

## Teste manual de conflito de horários

1. Abra a página de agendamento em duas abas e selecione o mesmo serviço, a mesma data e um horário livre nas duas.
2. Preencha o nome e confirme a reserva na primeira aba. A confirmação aparece em verde.
3. Sem recarregar a segunda aba, tente confirmar o mesmo horário. A página avisa em vermelho que o horário foi ocupado e atualiza a lista de horários disponíveis.
