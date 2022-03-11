FROM public.ecr.aws/lambda/python:3.7 as build_stage

RUN yum install zip -y

RUN mkdir layer
WORKDIR /layer
COPY requirements.txt .
RUN  pip3 install -r requirements.txt -t python

RUN zip -r layer.zip .


FROM scratch as export_stage
COPY --from=build_stage /layer/layer.zip .