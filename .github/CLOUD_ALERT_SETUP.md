# CareerOps 카카오 A등급 알림

GitHub Actions가 매일 00:00 UTC(한국시간 오전 9시)에 사람인 최신 공고를 검색하고 CareerOps 기준으로 평가합니다.

- 새 A등급 공고만 PlayMCP의 `KakaotalkChat-MemoChat`으로 발송합니다.
- `.github/career-alert-state.json`은 최초 중복 방지 기준입니다.
- 이후 실행 이력은 GitHub Actions cache에 저장됩니다.
- PlayMCP 인증정보는 저장소 코드가 아닌 `MCPORTER_CREDENTIALS_B64` Actions Secret에만 저장합니다.
- 수동 실행은 Actions 탭의 `CareerOps A-grade Kakao Alerts`에서 `Run workflow`를 사용합니다.

토큰이나 `credentials.json` 원문을 저장소에 커밋하지 마세요.
