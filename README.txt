[실행 방법]

1. index.html, style.css, script.js, rat.fbx를 같은 폴더에 둡니다.
2. 해당 폴더에서 로컬 서버를 실행합니다.

Python:
  python -m http.server 8000

3. 브라우저에서:
  http://localhost:8000/

[조작]
W A S D : 모델의 로컬 방향 기준 이동
Shift : 달리기(별도 Run 클립이 있을 때 Run 사용, 없으면 Walk 사용)
Space : 점프
마우스 드래그 : 카메라 회전

[애니메이션 상태]
- Idle : 가만히 있을 때만 재생
- Walk : 이동할 때만 재생
- Jump : 점프 중일 때만 재생
- 상태가 바뀔 때만 애니메이션을 전환하므로 아무 행동도 하지 않을 때 자동으로 계속 재생되지 않습니다.

[중요: 현재 rat.fbx]
현재 FBX에서 명시적으로 확인되는 Animation Stack 이름은 `Take 001`입니다.
FBX 내부에 Idle / Walk / Jump가 별도 Animation Clip으로 저장되어 있지 않으면 브라우저에서 하나의 클립을 의미적으로 자동 분리할 수 없습니다.
이 경우 화면의 '행동별 애니메이션 매핑'에서 원하는 클립을 직접 지정하거나, Blender/3ds Max에서 Idle/Walk/Jump를 별도 액션/클립으로 내보내는 것이 가장 정확합니다.

[리깅 확인]
- Bone 수 표시
- 본 구조 표시
- 모델 로컬축 표시
