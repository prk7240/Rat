Rat FBX WebGL Animation Split Test

분석된 원본 Take 001을 실제 동작 구간으로 분리해 WebGL에서 사용합니다.

- Idle: 82~117 frame @ 30fps
- Walk: 40~78 frame @ 30fps
- Jump: 240~270 frame @ 30fps

모델 정면은 FBX 구조의 Head_CTRL 위치를 기준으로 로컬 +Z로 판정했습니다.
따라서 W는 모델의 실제 머리 방향, A/D는 모델의 좌우 방향을 기준으로 움직입니다.

실행:
python -m http.server 8000
http://localhost:8000/
