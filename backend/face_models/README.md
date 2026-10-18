Local inference models used by member face registration and attendance.
No model downloads occur when the application starts or a camera is used.

- `face_detection_yunet_2023mar.onnx`: copied unchanged from the supplied `cam` prototype. Upstream: https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet (MIT, see LICENSE-YuNet).
- `face_recognition_sface_2021dec.onnx`: OpenCV Zoo SFace model, https://github.com/opencv/opencv_zoo/tree/main/models/face_recognition_sface (Apache 2.0, see LICENSE-SFace).

SHA-256 checksums (verified when inference loads):

```
8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4  face_detection_yunet_2023mar.onnx
0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79  face_recognition_sface_2021dec.onnx
```
